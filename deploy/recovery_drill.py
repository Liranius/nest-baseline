"""Recover the stage 4 booking system from its latest online logical backup on Linux/WSL."""

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import secrets
import tempfile
import time

from recovery_store import RecoveryStage, backup, restore, utc
from release import NEW_DRILL_REVISION, eventually, http


def expect(actual, expected):
    if actual != expected:
        raise AssertionError(f"Expected {expected!r}, observed {actual!r}")
    return actual


class Clients:
    def __init__(self, stage):
        self.url = stage.url("proxy", 8080)
        self.tokens = {
            role: stage.login(self.url, login, stage.env["SEED_PASSWORD_" + role])
            for role, login in (("A", "employee-a"), ("B", "employee-b"), ("ADMIN", "lab-admin"))
        }

    def call(self, method, path, *, role="A", status=200, **kwargs):
        observed, payload, slot = http(
            self.url, method, "/v1" + path, token=self.tokens[role], **kwargs
        )
        expect(observed, status)
        return payload, slot

    def create(self, key, period, role="A"):
        payload, slot = self.call(
            "POST", "/reservations", role=role, status=201, key=key, body=period
        )
        return payload["id"], slot

    def booking(self, reservation, suffix="", method="GET", **kwargs):
        return self.call(method, "/reservations/" + reservation + suffix, **kwargs)[0]

    def notification(self, reservation, status):
        def lookup():
            rows = self.booking(reservation, "/notifications", role="ADMIN")
            return rows[0] if rows and rows[0]["status"] == status else None

        return eventually(lookup, timeout=45)


def wait_receiver(stage, company):
    port = {"A": 46201, "B": 46202}[company]
    eventually(
        lambda: stage.dc(
            "exec", "-T", "proxy", "sh", "-c", f"nc -z -w 1 127.0.0.1 {port} && echo ready || true"
        )
        == "ready"
    )


def callback_log(stage):
    lines = stage.dc("logs", "--no-log-prefix", "observer").splitlines()
    return [json.loads(line) for line in lines if line.startswith("{")]


def period(device, start):
    return {
        "equipmentId": device,
        "from": start.isoformat(timespec="milliseconds"),
        "to": (start + timedelta(hours=1)).isoformat(timespec="milliseconds"),
    }


def fixture(stage, api):
    devices, _ = api.call("GET", "/equipment")
    one, two = [device["id"] for device in devices]
    future = datetime(2042, 3, 1, tzinfo=timezone.utc)
    now = datetime.now(timezone.utc) - timedelta(minutes=2)
    loan, _ = api.create("outstanding-loan", period(one, now))
    already_returned, _ = api.create("completed-loan", period(two, now))
    for reservation in (loan, already_returned):
        api.booking(reservation, "/checkout", "PUT", role="ADMIN")
    api.booking(already_returned, "/return", "PUT", role="ADMIN")
    cancelled, _ = api.create("cancelled", period(one, future))
    api.booking(cancelled, method="DELETE", status=204)

    # Persist an actual exhausted delivery and operator replay in the backup.
    stage.dc("stop", "receiver-b")
    prior, _ = api.create("pre-backup-replay", period(two, future), "B")
    failure = api.notification(prior, "failed")
    expect(failure["failureReason"], "exhausted")
    stage.dc("start", "receiver-b")
    wait_receiver(stage, "B")
    api.call(
        "POST",
        "/notification-deliveries/" + failure["deliveryId"] + "/replay",
        role="ADMIN",
        status=202,
    )
    history = api.notification(prior, "succeeded")
    expect((len(history["history"]), len(history["replays"])), (6, 1))
    stage.dc("stop", "worker", "receiver-b")

    reserved = period(one, future + timedelta(days=1))
    confirmed, source_slot = api.create("confirmed", reserved)
    location = {"pickupLocation": "North lab / desk 5"}
    api.booking(confirmed, "/pickup-location", "PUT", role="ADMIN", body=location)
    pending_b, _ = api.create("b-pending", period(two, future + timedelta(days=1)), "B")
    ids = {
        "confirmed": confirmed,
        "cancelled": cancelled,
        "checkedOut": loan,
        "returned": already_returned,
    }
    handovers = {name: api.booking(rid, "/handover") for name, rid in ids.items()}
    audits = {name: api.booking(rid, "/audit", role="ADMIN") for name, rid in ids.items()}
    expect(
        [handovers[name]["state"] for name in ids],
        ["pending", "cancelled", "checked_out", "returned"],
    )
    return {
        "ids": ids,
        "reservations": {name: api.booking(rid) for name, rid in ids.items()},
        "handovers": handovers,
        "audits": audits,
        "sourceSlot": source_slot,
        "reserved": reserved,
        "location": location,
        "priorId": prior,
        "history": history,
        "pending": {"A": confirmed, "B": pending_b},
        "markerPeriod": period(one, future + timedelta(days=2)),
        "newPeriod": period(one, future + timedelta(days=3)),
    }


def receiver_state(stage, company, event, rid):
    # The unchanged tuple version (xmin) also detects a second update of the external projection.
    schema = {"A": "company_a_receiver", "B": "company_b_receiver"}[company]
    return json.loads(
        stage.query(
            "receiver-db",
            f"""SELECT json_build_object(
        'inboxRows', (SELECT count(*) FROM {schema}.inbox WHERE id='{event}'),
        'projection', (SELECT json_build_object('status',status,'version',version,'tuple',xmin::text)
                       FROM {schema}.reservations WHERE reservation_id='{rid}'))""",
        )
    )


def check_business(api, stage, data, marker):
    ids = data["ids"]
    for name, rid in ids.items():
        expect(api.booking(rid), data["reservations"][name])
        expect(api.booking(rid, "/handover"), data["handovers"][name])
        expect(api.booking(rid, "/audit", role="ADMIN"), data["audits"][name])
    confirmed = ids["confirmed"]
    expect(api.booking(confirmed, "/pickup-location"), data["location"])
    api.booking(confirmed, "/pickup-location", role="B", status=404)
    api.booking(marker, status=404)
    peer = "b" if data["sourceSlot"] == "a" else "a"
    code, reply, _ = http(
        stage.url("slot-" + peer, 3000),
        "POST",
        "/v1/reservations",
        data["reserved"],
        api.tokens["A"],
        "confirmed",
    )
    expect((code, reply), (201, {"id": confirmed}))
    conflict, _ = api.call(
        "POST", "/reservations", body=data["reserved"], key="overlap", role="B", status=409
    )
    expect(conflict["code"], "SLOT_CONFLICT")
    loan = ids["checkedOut"]
    receipt = api.booking(loan, "/return", "PUT", role="ADMIN")
    expect(api.booking(loan, "/return", "PUT", role="ADMIN"), receipt)
    events = api.booking(loan, "/audit", role="ADMIN")["events"]
    expect(events[:-1], data["audits"]["checkedOut"]["events"])
    expect(events[-1]["action"], "returned")
    expect(receipt["handoverId"], data["handovers"]["checkedOut"]["checkout"]["handoverId"])
    expect(api.booking(data["priorId"], "/notifications", role="ADMIN")[0], data["history"])
    new_id, _ = api.create("first-recovered-write", data["newPeriod"])
    return {
        "idempotentReplay": {
            "fromSlot": data["sourceSlot"],
            "toSlot": peer,
            "reservationId": confirmed,
        },
        "location": data["location"]["pickupLocation"],
        "crossTenantHttp": 404,
        "overlap": conflict["code"],
        "verifiedReservationStates": {
            name: row["state"] for name, row in data["handovers"].items()
        },
        "confirmedPeriod": data["reserved"],
        "returnReceipt": receipt,
        "addedReturnAuditRows": 1,
        "newReservation": new_id,
        "historicalDelivery": {
            "id": data["history"]["deliveryId"],
            "attempts": 6,
            "replays": data["history"]["replays"],
        },
    }


def drill(stage, directory):
    start = utc()
    stage.env["RECEIVER_DATABASE_URL"] = stage.database_url("receiver-db")
    stage.dc("up", "-d", "--wait", "receiver-db")
    stage.init()
    stage.dc("up", "-d", "--no-deps", "observer")
    eventually(
        lambda: stage.dc(
            "exec",
            "-T",
            "proxy",
            "sh",
            "-c",
            "nc -z -w 1 127.0.0.1 46101 && nc -z -w 1 127.0.0.1 46102 && echo up || true",
        )
        == "up"
    )
    stage.gate(True)
    api = Clients(stage)
    source_cluster = stage.query("db", "SELECT system_identifier FROM pg_control_system()")
    external_cluster = stage.query(
        "receiver-db", "SELECT system_identifier FROM pg_control_system()"
    )
    data = fixture(stage, api)
    events = {
        company: api.notification(rid, "queued")["eventId"]
        for company, rid in data["pending"].items()
    }
    archive = backup(stage, directory, lambda: api.call("GET", "/equipment"))
    manifest = json.loads((directory / "manifest.json").read_text())
    print("Consistent snapshot backed up:", manifest["snapshotUtc"], flush=True)
    stage.worker("NEW")
    sent_a = api.notification(data["pending"]["A"], "succeeded")
    expect(sent_a["eventId"], events["A"])
    stage.dc("stop", "worker")

    def external():
        return {
            org: receiver_state(stage, org, event, data["pending"][org])
            for org, event in events.items()
        }

    before = external()
    expect(before["A"]["inboxRows"], 1)
    expect(before["B"], {"inboxRows": 0, "projection": None})
    marker, _ = api.create("after-snapshot", data["markerPeriod"])
    marker_time = api.booking(marker, "/audit", role="ADMIN")["events"][0]["at"]

    source_ids = set(stage.query("db", "SELECT id FROM reservations").splitlines())
    excluded = sorted(source_ids.difference(manifest["reservationIds"]))
    expect(excluded, [marker])
    expect(sent_a["history"][-1]["statusCode"], 204)
    for slot in "ab":
        stage.drain(slot)
    fault_utc = utc()
    clock = time.monotonic()
    stage.dc("stop", "slot-a", "slot-b", "db")
    callbacks_at_fault = callback_log(stage)

    def closed():
        expect(http(api.url, "GET", "/health/ready")[0], 503)
        expect(
            stage.dc("ps", "--services", "--status", "running", "worker", "slot-a", "slot-b", "db"),
            "",
        )
        expect(external(), before)
        expect(callback_log(stage), callbacks_at_fault)

    closed()
    print("Source isolated; checking failure cases", flush=True)
    damaged = directory / "damaged.dump"
    damaged.write_bytes(archive.read_bytes()[:-1])
    stage.dc("up", "-d", "--wait", "rejected-db")
    key = stage.env["NOTIFICATION_ENCRYPTION_KEY"]
    failures = []
    for bad_archive, bad_key, reason in (
        (damaged, key, "ARCHIVE_CHECKSUM_MISMATCH"),
        (archive, secrets.token_hex(32), "RECOVERY_KEY_MISMATCH"),
    ):
        try:
            restore(stage, "rejected-db", bad_archive, manifest, bad_key)
        except (ValueError, RuntimeError) as error:
            if reason not in str(error):
                raise
        else:
            raise AssertionError("Expected rejection: " + reason)
        closed()
        failures.append(
            {
                "reason": reason,
                "publicHttp": 503,
                "runningWorkers": 0,
                "outboundHttpRequests": 0,
                "newReceiverEffects": 0,
            }
        )

    stage.dc("up", "-d", "--wait", "restored-db")
    tables = restore(stage, "restored-db", archive, manifest, key)
    restored_cluster = stage.query(
        "restored-db", "SELECT system_identifier FROM pg_control_system()"
    )
    expect(len({source_cluster, external_cluster, restored_cluster}), 3)
    expect(
        stage.query("restored-db", f"SELECT count(*) FROM reservations WHERE id='{marker}'"), "0"
    )
    stage.select_database("restored-db")
    for slot in "ab":
        base = stage.start_slot(slot, "NEW")
        eventually(lambda: stage.probe(base, "NEW"))
    stage.dc("start", "receiver-b")
    wait_receiver(stage, "B")
    stage.worker("NEW")
    for slot in "ab":
        stage.admit(slot)
    recovered = Clients(stage)
    expect(recovered.url, api.url)
    # Check both the original signing configuration and fresh logins.
    expect(http(api.url, "GET", "/v1/me", token=api.tokens["A"])[0], 200)
    business = check_business(recovered, stage, data, marker)
    deliveries = {}
    for org, event in events.items():
        row = recovered.notification(data["pending"][org], "succeeded")
        expect(row["eventId"], event)
        expect(row["history"][-1]["statusCode"], 204)
        after = receiver_state(stage, org, event, data["pending"][org])
        expect(after["inboxRows"], 1)
        expect((after["projection"]["status"], after["projection"]["version"]), ("confirmed", 1))
        if org == "A":
            expect(after, before["A"])
        other = "B" if org == "A" else "A"
        expect(receiver_state(stage, other, event, data["pending"][org])["inboxRows"], 0)
        log = callback_log(stage)
        expect(log[: len(callbacks_at_fault)], callbacks_at_fault)

        def successes(records):
            return sum(
                item == {"company": org, "eventId": event, "phase": "reply", "status": 204}
                for item in records
            )

        prior_successes = successes(callbacks_at_fault)
        restored_successes = successes(log[len(callbacks_at_fault) :])
        expect((prior_successes, restored_successes), (1 if org == "A" else 0, 1))
        deliveries[org] = {
            "beforeFaultSuccessfulHttp": prior_successes,
            "restoredSuccessfulHttp": restored_successes,
            "eventId": event,
            "reservationId": data["pending"][org],
            "before": before[org],
            "after": after,
            "restoredHttp": 204,
            "otherCompanyRows": 0,
        }
    elapsed = round(time.monotonic() - clock, 3)
    finished = utc()
    if elapsed > 300:
        raise AssertionError(f"Recovery exceeded five minutes: {elapsed}s")
    return {
        "startedUtc": start,
        "revision": stage.env["NEW_IMAGE"].split(":")[1],
        "backup": manifest,
        "matchedTables": tables,
        "pendingMigrations": 0,
        "sampleReservations": data["ids"],
        "faultUtc": fault_utc,
        "clusterIds": {
            "source": source_cluster,
            "external": external_cluster,
            "restored": restored_cluster,
        },
        "excludedReservationIds": excluded,
        "lastExcludedWrite": {
            "key": "after-snapshot",
            "reservationId": marker,
            "sourceHttp": 201,
            "createdUtc": marker_time,
            "restoredHttp": 404,
        },
        "snapshotToFaultSeconds": round(
            (
                datetime.fromisoformat(fault_utc) - datetime.fromisoformat(manifest["snapshotUtc"])
            ).total_seconds(),
            3,
        ),
        "failures": failures,
        "business": business,
        "deliveries": deliveries,
        "sourceAHttp": sent_a["history"][-1]["statusCode"],
        "completedUtc": finished,
        "recoverySeconds": elapsed,
        "targetSeconds": 300,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="booking-recovery-") as tmp:
        root = Path(tmp)
        stage = RecoveryStage.create(root / "control", NEW_DRILL_REVISION, NEW_DRILL_REVISION)
        archives = root / "archives"
        archives.mkdir(mode=0o700)
        try:
            evidence = drill(stage, archives)
        finally:
            stage.dc(
                "--profile", "jobs", "--profile", "drill", "down", "--volumes", "--remove-orphans"
            )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"Recovery accepted in {evidence['recoverySeconds']} seconds. Report: {args.output}")
