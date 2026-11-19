"""Exercise a real rolling deployment, rollback and re-release, with the stage 3 client under load."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time

from release import Stage, eventually, http, run


def millis():
    return time.time_ns() // 1_000_000


def expect(actual, expected):
    if actual != expected:
        raise AssertionError(f"Expected {expected!r}, observed {actual!r}")
    return actual


@contextmanager
def locked(stage, statement):
    command = stage.command(
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
    child = subprocess.Popen(
        command,
        env={**os.environ, **stage.env},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        child.stdin.write("BEGIN; " + statement + "; SELECT 'locked';\n")
        child.stdin.flush()
        if (
            not select.select([child.stdout], [], [], 8)[0]
            or child.stdout.readline().strip() != "locked"
        ):
            raise RuntimeError("Control transaction did not acquire lock")
        yield
    finally:
        child.stdin.close()  # psql disconnects, PostgreSQL rolls back this transaction
        child.wait(timeout=10)
        child.stdout.close()


def exercise(s, out):
    url = s.url("proxy", 8080)
    a = s.login(url, "employee-a", s.env["SEED_PASSWORD_A"])
    b = s.login(url, "employee-b", s.env["SEED_PASSWORD_B"])
    admin = s.login(url, "lab-admin", s.env["SEED_PASSWORD_ADMIN"])
    status, devices, _ = http(url, "GET", "/v1/equipment", token=a)
    expect(status, 200)
    device = devices[1]["id"]

    def call(method, path, body=None, token=a, key=None, status=200):
        code, payload, slot = http(url, method, path, body, token, key)
        expect(code, status)
        return payload, slot

    def create(label, hour, token=a):
        payload = {
            "equipmentId": device,
            "from": f"2042-03-01T{hour:02}:00:00Z",
            "to": f"2042-03-01T{hour + 1:02}:00:00Z",
        }
        data, slot = call("POST", "/v1/reservations", payload, token, label, 201)
        return data["id"], slot

    def notices(id):
        return call("GET", f"/v1/reservations/{id}/notifications", token=admin)[0]

    def delivery(id, status):
        rows = notices(id)
        return rows[0] if rows and rows[0]["status"] == status else None

    def images():
        return {name: s.image(name) for name in ["slot-a", "slot-b", "worker"]}

    phases = []

    def phase(name):
        phases.append((name, millis()))
        print(
            datetime.now(timezone.utc).isoformat(timespec="seconds"), name, flush=True
        )

    ev = {
        "project": s.env["PROJECT"],
        "started": datetime.now(timezone.utc).isoformat(),
        "oldRevision": s.env["OLD_IMAGE"].split(":")[1],
        "newRevision": s.env["NEW_IMAGE"].split(":")[1],
        "oldImage": s.env["OLD_ID"],
        "newImage": s.env["NEW_ID"],
        "baseImages": images(),
        "postgres": s.sql("SHOW server_version"),
        "compose": run(["docker", "compose", "version", "--short"]),
    }
    ev["clientImage"] = run(
        ["docker", "image", "inspect", "-f", "{{.Id}}", s.env["CLIENT_IMAGE"]]
    )
    expect(set(ev["baseImages"].values()), {s.env["OLD_ID"]})
    historical, _ = create("old-reservation", 1)

    def location(reservation_id):
        return f"/v1/reservations/{reservation_id}/pickup-location"

    # Retain a real 5-failure + operator replay history across both release boundaries.
    s.dc("stop", "receiver-b")
    past, _ = create("old-replay", 2, b)
    failed = eventually(lambda: delivery(past, "failed"), 45)
    expect(failed["failureReason"], "exhausted")
    s.dc("start", "receiver-b")
    eventually(
        lambda: s.dc(
            "exec",
            "-T",
            "proxy",
            "sh",
            "-c",
            "nc -z -w 1 127.0.0.1 46102 >/dev/null 2>&1 && echo ready || true",
        )
        == "ready"
    )
    call(
        "POST",
        f"/v1/notification-deliveries/{failed['deliveryId']}/replay",
        token=admin,
        status=202,
    )
    history = eventually(lambda: delivery(past, "succeeded"))
    expect(len(history["history"]), 6)
    expect(len(history["replays"]), 1)
    ev["historicalNotification"] = {
        "reservationId": past,
        "eventId": history["eventId"],
        "deliveryId": history["deliveryId"],
        "attempts": history["attempts"],
        "replays": history["replays"],
    }

    s.dc("up", "-d", "--no-deps", "traffic")
    eventually(
        lambda: '"action":"cancel"' in s.dc("logs", "--no-log-prefix", "traffic")
    )
    phase("baseline")
    with locked(s, "LOCK TABLE reservations IN ACCESS SHARE MODE"):
        start = time.monotonic()
        try:
            s.migrate("NEW")
        except RuntimeError as error:
            if "lock timeout" not in str(error) and "55P03" not in str(error):
                raise
        else:
            raise AssertionError("Migration unexpectedly acquired its DDL lock")
        elapsed = round(time.monotonic() - start, 3)
    exists = s.sql(
        "SELECT count(*) FROM information_schema.columns WHERE table_name='reservations' AND column_name='pickup_location'"
    )
    record = s.sql(
        "SELECT count(*) FROM migrations WHERE name='PickupLocation1795200000000'"
    )
    expect([exists, record], ["0", "0"])
    create("after-failed-migration", 3)
    ev["migrationFailure"] = {
        "lockTimeoutMs": 350,
        "jobSeconds": elapsed,
        "columnCount": int(exists),
        "migrationRows": int(record),
    }
    phase("migration")
    if "Migrations applied: 1" not in s.migrate("NEW"):
        raise AssertionError("Expansion missing")
    if "Migrations applied: 0" not in s.migrate("NEW"):
        raise AssertionError("Migration repeated")
    ev["migrationApplied"] = {"first": 1, "repeat": 0}

    phase("candidate-rejected")
    s.drain("a")
    before = int(s.stats("a")["stot"])
    candidate = s.start_slot(
        "a",
        "NEW",
        {
            "A_DATABASE_URL": s.env["A_DATABASE_URL"]
            + "&options=-csearch_path%3Dpg_catalog"
        },
    )

    def unready():
        try:
            return http(candidate, "GET", "/health/ready")[0] == 503
        except OSError:
            return False

    eventually(unready)
    expect(s.probe(candidate, "NEW"), False)
    expect(http(candidate, "HEAD", "/")[0], 503)
    _, survivor = create("during-failed-admission", 4)
    after = int(s.stats("a")["stot"])
    expect([after - before, survivor], [0, "b"])
    s.replace("a", "OLD")
    ev["failedAdmission"] = {
        "slot": "a",
        "directReadiness": 503,
        "newUserSessions": after - before,
        "servingPeer": survivor,
    }
    phase("drain")
    with ThreadPoolExecutor(max_workers=1) as pool:
        with locked(
            s,
            f"DO $$ BEGIN PERFORM id FROM equipment WHERE id='{device}' FOR NO KEY UPDATE; END $$",
        ):
            pending = pool.submit(create, "in-flight", 5)

            def waiting_slot():
                return s.sql(
                    "SELECT right(application_name,1) FROM pg_stat_activity WHERE wait_event_type='Lock' AND application_name IN ('stage4_a','stage4_b') AND query LIKE '%equipment%FOR NO KEY UPDATE%' LIMIT 1"
                )

            first = eventually(waiting_slot, 3)
            s.change("set server booking/" + first + " state drain")
            expect(pending.done(), False)
            admitted = int(s.stats(first)["stot"])
            peer = "b" if first == "a" else "a"
            peer_before = int(s.stats(peer)["stot"])
            time.sleep(1.1)
            expect(int(s.stats(first)["stot"]), admitted)
            peer_new = int(s.stats(peer)["stot"]) - peer_before
            if peer_new < 1:
                raise AssertionError("Peer received no traffic during drain")
        slow_id, responding = pending.result(timeout=8)
    expect(responding, first)
    expect(
        s.sql("SELECT count(*) FROM reservations WHERE idempotency_key='in-flight'"),
        "1",
    )
    svc = "slot-" + first
    old_cid = s.dc("ps", "-q", svc)
    start = time.monotonic()
    s.dc("stop", "-t", "15", svc)
    stopped = round(time.monotonic() - start, 3)
    code, oom = run(
        ["docker", "inspect", "-f", "{{.State.ExitCode}} {{.State.OOMKilled}}", old_cid]
    ).split()
    if code not in ("0", "143") or oom != "false" or stopped >= 15:
        raise AssertionError("Old API did not stop cleanly")
    ev["drain"] = {
        "slot": first,
        "id": slow_id,
        "http": 201,
        "databaseRows": 1,
        "newSessionsOnDrainingSlot": 0,
        "newPeerSessions": peer_new,
        "oldContainer": old_cid,
        "exitCode": int(code),
        "stopSeconds": stopped,
        "graceSeconds": 15,
    }
    s.replace(first, "NEW")
    ev["mixedImages"] = images()
    phase("mixed")
    mixed_start = time.monotonic()
    mixed_id, _ = create("mixed-reservation", 6)
    cancel_id, _ = create("cancel-after-rollback", 7)
    expect(http(url, "GET", location(mixed_id), token=a)[0], 503)
    expect(
        http(s.url(svc, 3000), "GET", location(historical), token=a)[:2],
        (200, {"pickupLocation": None}),
    )
    time.sleep(max(0, 61 - (time.monotonic() - mixed_start)))
    phase("upgrade")
    s.replace(peer, "NEW")

    def queue_for_handoff(key, hour):
        s.dc("stop", "-t", "15", "worker")
        rid, _ = create(key, hour)
        queued = notices(rid)[0]
        expect(queued["status"], "queued")
        return rid, queued["eventId"]

    def verify_handoff(rid, event_id):
        done = eventually(lambda: delivery(rid, "succeeded"))
        expect(event_id, done["eventId"])
        count = s.sql(
            f"SELECT count(*) FROM company_a_receiver.inbox WHERE id='{event_id}'"
        )
        expect(count, "1")
        return {
            "reservationId": rid,
            "eventId": done["eventId"],
            "before": "queued",
            "after": "succeeded",
            "receiverRows": 1,
            "attempts": done["attempts"],
            "workerImage": s.image("worker"),
        }

    waiting = queue_for_handoff("worker-up", 8)
    s.rollout("NEW")
    ev["upgradeDelivery"] = verify_handoff(*waiting)
    ev["upgradedImages"] = images()
    expect(set(ev["upgradedImages"].values()), {s.env["NEW_ID"]})
    expect(call("GET", location(historical))[0], {"pickupLocation": None})
    place = {"pickupLocation": "North lab / desk 4"}
    expect(call("PUT", location(mixed_id), place, admin)[0], place)
    expect(call("GET", location(mixed_id))[0], place)
    call("GET", location(mixed_id), token=b, status=404)
    phase("rollback")
    waiting = queue_for_handoff("worker-back", 9)
    start = time.monotonic()
    s.rollout("OLD")
    ev["rollbackSeconds"] = round(time.monotonic() - start, 3)
    expect(http(url, "GET", location(mixed_id).upper() + "/", token=a)[0], 503)
    ev["rollbackDelivery"] = verify_handoff(*waiting)
    ev["rollbackImages"] = images()
    expect(set(ev["rollbackImages"].values()), {s.env["OLD_ID"]})
    phase("on-previous")
    expect(call("GET", "/v1/reservations/" + mixed_id)[0]["id"], mixed_id)
    call("DELETE", "/v1/reservations/" + cancel_id, status=204)
    expect(call("GET", "/v1/reservations/" + cancel_id)[0]["status"], "cancelled")
    expect(
        s.sql(f"SELECT pickup_location FROM reservations WHERE id='{mixed_id}'"),
        place["pickupLocation"],
    )
    expect(notices(past)[0], history)
    phase("redeploy")
    s.rollout("NEW")
    ev["redeployedImages"] = images()
    expect(ev["redeployedImages"], ev["upgradedImages"])
    expect(call("GET", location(mixed_id))[0], place)
    expect(notices(past)[0], history)
    ev["data"] = {
        "historicalReservation": historical,
        "historicalLocation": None,
        "upgradedReservation": mixed_id,
        "writtenLocation": place["pickupLocation"],
        "afterRedeploy": call("GET", location(mixed_id))[0]["pickupLocation"],
        "otherEmployeeStatus": 404,
        "cancelledByOldRelease": cancel_id,
        "historyUnchanged": True,
    }
    phase("finished")
    s.dc("stop", "-t", "15", "traffic")
    trace = s.dc("logs", "--no-log-prefix", "traffic")
    samples = [json.loads(line) for line in trace.splitlines() if line.startswith("{")]
    if any(row.get("error") or row.get("slot") not in ("a", "b") for row in samples):
        raise AssertionError(
            "Legacy client error: "
            + str([r for r in samples if r.get("error") or not r.get("slot")][:3])
        )
    ev["traffic"] = {}
    for (name, t0), (_, t1) in zip(phases, phases[1:]):
        window = [row for row in samples if t0 <= row["start"] < t1]
        rate = len(window) * 1000 / (t1 - t0)
        stats = {
            "startUtc": datetime.fromtimestamp(t0 / 1000, timezone.utc).isoformat(),
            "seconds": round((t1 - t0) / 1000, 3),
            "requests": len(window),
            "rps": round(rate, 2),
            "bySlot": dict(Counter(row["slot"] for row in window)),
            "http": dict(Counter(row["status"] for row in window)),
        }
        ev["traffic"][name] = stats
        if name == "mixed" and ((t1 - t0) < 60000 or len(stats["bySlot"]) != 2):
            raise AssertionError("Mixed window missing")
        if t1 - t0 >= 1000 and rate < 2:
            raise AssertionError(f"Traffic rate too low in {name}: {rate}")
    rows = [row for row in samples if phases[0][1] <= row["start"] < phases[-1][1]]
    gaps = [later["start"] - earlier["start"] for earlier, later in zip(rows, rows[1:])]
    if max(gaps) > 1000:
        raise AssertionError("Legacy client traffic stalled")
    ev["legacyClient"] = {
        "requests": len(rows),
        "actions": dict(Counter(r["action"] for r in rows)),
        "expectedConflicts": sum(r["status"] == 409 for r in rows),
        "unexpectedErrors": 0,
        "maxStartGapMs": max(gaps),
        "maxResponseMs": max(r["end"] - r["start"] for r in rows),
    }
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    raw = out.with_suffix(".jsonl")
    raw.write_text("".join(json.dumps(row) + "\n" for row in samples))
    ev["trafficTraceSha256"] = hashlib.sha256(raw.read_bytes()).hexdigest()
    ev["completed"] = datetime.now(timezone.utc).isoformat()
    out.write_text(json.dumps(ev, ensure_ascii=False, indent=2) + "\n")
    print("Acceptance passed:", out, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old", default="82bafe6")
    parser.add_argument("--new", default="01e2712")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="booking-drill-") as parent:
        stage = Stage.create(Path(parent) / "control", args.old, args.new)
        try:
            stage.init()
            exercise(stage, args.output)
        finally:
            stage.dc(
                "--profile",
                "drill",
                "--profile",
                "jobs",
                "down",
                "--remove-orphans",
                "--volumes",
            )
