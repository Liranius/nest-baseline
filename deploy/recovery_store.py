"""PostgreSQL backup, verification and restore primitives for the disposable stage 5 environment."""

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import select
import subprocess

from release import HERE, Stage


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class RecoveryStage(Stage):
    def command(self, *args):
        return super().command("-f", str(HERE / "recovery.compose.yaml"), *args)

    def database_url(self, service):
        return f"postgresql://booking:{self.env['DB_PASS']}@{service}:5432/staging"

    def query(self, service, sql):
        return self.dc(
            "exec",
            "-T",
            service,
            "psql",
            "-XqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "booking",
            "-d",
            "staging",
            "-c",
            sql,
        )

    def select_database(self, service):
        url = self.database_url(service)
        self.env.update(DATABASE_URL=url, A_DATABASE_URL=url, B_DATABASE_URL=url)


def transfer(stage, service, command, *, stdin=None, stdout=None):
    subprocess.run(
        stage.command("exec", "-T", service, *command),
        env={**os.environ, **stage.env},
        stdin=stdin,
        stdout=stdout,
        check=True,
        timeout=90,
    )


@contextmanager
def snapshot(stage):
    args = stage.command(
        "exec",
        "-T",
        "db",
        "psql",
        "-XqAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "booking",
        "-d",
        "staging",
    )
    with subprocess.Popen(
        args,
        env={**os.environ, **stage.env},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    ) as session:
        try:
            session.stdin.write(
                "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
                "SELECT json_build_array(pg_export_snapshot(), extract(epoch FROM statement_timestamp()));\n"
            )
            session.stdin.flush()
            if not select.select([session.stdout], [], [], 10)[0]:
                raise TimeoutError("PostgreSQL did not export a snapshot")
            snapshot_id, timestamp = json.loads(session.stdout.readline())
            if not re.fullmatch(r"[0-9a-fA-F-]+", snapshot_id):
                raise ValueError("Unexpected PostgreSQL snapshot identifier")
            yield (
                snapshot_id,
                datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="microseconds"),
            )
        finally:
            session.stdin.close()
            session.wait(timeout=10)


def inventory(stage, service, snapshot_id=None):
    # For the small reference dataset, compare every user table, in deterministic row order.
    begin = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
    if snapshot_id:
        begin += f" SET TRANSACTION SNAPSHOT '{snapshot_id}';"

    def query(sql):
        return stage.query(service, begin + " SET LOCAL TIME ZONE 'UTC'; " + sql + "; COMMIT;")

    tables = query("""SELECT format('%I.%I', schemaname, tablename) FROM pg_tables
        WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema'
        ORDER BY schemaname, tablename""").splitlines()
    result = {}
    for table in tables:
        count, digest = query(f"""SELECT count(*), encode(sha256(convert_to(
            coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text COLLATE "C"),''),
            'UTF8')), 'hex') FROM {table} t""").split("|")
        result[table] = {"rows": int(count), "sha256": digest}
    return result


def file_digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def backup(stage, directory, verify_source_online):
    archive = directory / "staging.dump"
    with snapshot(stage) as (snapshot_id, timestamp):
        manifest = {
            "snapshotId": snapshot_id,
            "snapshotUtc": timestamp,
            "imageId": stage.env["NEW_ID"],
            "postgres": stage.query("db", "SHOW server_version"),
        }
        verify_source_online()
        with archive.open("xb") as stream:
            transfer(
                stage,
                "db",
                ["pg_dump", "-U", "booking", "-d", "staging", "-Fc", "--snapshot", snapshot_id],
                stdout=stream,
            )
        manifest["tables"] = inventory(stage, "db", snapshot_id)
        manifest["reservationIds"] = stage.query(
            "db",
            f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
            SET TRANSACTION SNAPSHOT '{snapshot_id}'; SELECT id FROM reservations ORDER BY id; COMMIT""",
        ).splitlines()
    manifest.update(sha256=file_digest(archive), bytes=archive.stat().st_size, completedUtc=utc())
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return archive


def restore(stage, service, archive, manifest, key):
    if service not in ("rejected-db", "restored-db"):
        raise ValueError("Expected an isolated recovery database")
    if file_digest(archive) != manifest["sha256"] or archive.stat().st_size != manifest["bytes"]:
        raise ValueError("ARCHIVE_CHECKSUM_MISMATCH")
    if manifest["imageId"] != stage.env["NEW_ID"]:
        raise ValueError("Backup image does not match the recovery release")
    if inventory(stage, service):
        raise ValueError("Recovery requires a new, empty database")
    with archive.open("rb") as stream:
        transfer(
            stage,
            service,
            [
                "pg_restore",
                "--single-transaction",
                "--exit-on-error",
                "-U",
                "booking",
                "-d",
                "staging",
            ],
            stdin=stream,
        )
    actual = inventory(stage, service)
    if actual != manifest["tables"]:
        raise ValueError("Restored table inventory differs from the exported snapshot")
    verified = stage.dc(
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "job",
        "node",
        "verify-recovery.mjs",
        override={
            "DATABASE_URL": stage.database_url(service)
            + "?options=-cdefault_transaction_read_only%3Don",
            "NOTIFICATION_ENCRYPTION_KEY": key,
        },
    )
    if "0 pending migrations; verified both restored signing secrets" not in verified:
        raise ValueError("Recovery preflight did not complete")
    return len(actual)
