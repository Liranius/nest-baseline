"""Local preproduction deployment. Run in Linux/WSL; state must live on a Linux filesystem."""

import argparse
import base64
import csv
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

HERE = Path(__file__).resolve().parent
OLD_DRILL_REVISION = "booking-drill-v1"
NEW_DRILL_REVISION = "booking-drill-v2"


def run(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=120, **kwargs)
    if result.returncode:
        raise RuntimeError(
            f"{args[0]} returned {result.returncode}: {(result.stderr or result.stdout)[-1800:]}"
        )
    return result.stdout.strip()


def eventually(read, timeout=25):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Timed out after {timeout}s: {read.__name__}")
        time.sleep(0.15)


def http(base, method, path, body=None, token=None, key=None):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if key:
        headers["Idempotency-Key"] = key
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = Request(
        base + path,
        method=method,
        headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        reply = urlopen(req, timeout=10)
    except HTTPError as error:
        reply = error
    with reply:
        value = reply.read()
        if value and "application/json" in reply.headers.get("Content-Type", ""):
            value = json.loads(value)
        return reply.status, value, reply.headers.get("X-Booking-Slot")


class Stage:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.file = self.root / "state.json"
        self.env = json.loads(self.file.read_text())

    @classmethod
    def create(cls, root, old, new):
        root = Path(root).resolve()
        root.mkdir(mode=0o700, exist_ok=False)
        env = {
            k: secrets.token_hex(32)
            for k in (
                "DB_PASS",
                "JWT_SECRET",
                "NOTIFICATION_ENCRYPTION_KEY",
                "SEED_PASSWORD_A",
                "SEED_PASSWORD_B",
                "SEED_PASSWORD_ADMIN",
            )
        }
        for org in "AB":
            env["WEBHOOK_SECRET_" + org] = (
                "whsec_" + base64.b64encode(secrets.token_bytes(32)).decode()
            )
        for label, ref in [("OLD", old), ("NEW", new)]:
            sha = run(
                [
                    "git",
                    "-C",
                    str(HERE.parent),
                    "rev-parse",
                    "--verify",
                    ref + "^{commit}",
                ]
            )
            tag = "booking-release:" + sha
            if (
                run(
                    [
                        "docker",
                        "image",
                        "inspect",
                        "-f",
                        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
                        tag,
                    ]
                )
                != sha
            ):
                raise ValueError("Incorrect image revision: " + tag)
            env[label + "_IMAGE"] = tag
            env[label + "_ID"] = run(
                ["docker", "image", "inspect", "-f", "{{.Id}}", tag]
            )
        env["CLIENT_IMAGE"] = env["OLD_IMAGE"].replace(
            "booking-release:", "booking-contract-client:"
        )
        env["DATABASE_URL"] = f"postgresql://booking:{env['DB_PASS']}@db:5432/staging"
        env.update(
            CONTROL_DIR=str(root),
            RUN_UID=str(os.getuid()),
            RUN_GID=str(os.getgid()),
            PROJECT="booking-drill-" + uuid4().hex[:10],
        )
        for k in ["A", "B"]:
            env[k + "_DATABASE_URL"] = (
                env["DATABASE_URL"] + "?application_name=stage4_" + k.lower()
            )
            env[k + "_IMAGE"] = env["OLD_IMAGE"]
        env["WORKER_IMAGE"] = env["JOB_IMAGE"] = env["OLD_IMAGE"]
        with (root / "state.json").open("x") as out:
            os.fchmod(out.fileno(), 0o600)
            json.dump(env, out)
        return cls(root)

    def save(self):
        tmp = self.file.with_suffix(".tmp")
        with tmp.open("w") as out:
            os.fchmod(out.fileno(), 0o600)
            json.dump(self.env, out)
        tmp.replace(self.file)

    def command(self, *args):
        return [
            "docker",
            "compose",
            "-p",
            self.env["PROJECT"],
            "-f",
            str(HERE / "compose.yaml"),
            *args,
        ]

    def dc(self, *args, override=None):
        return run(
            self.command(*args), env={**os.environ, **self.env, **(override or {})}
        )

    def sql(self, stmt):
        return self.dc(
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
            "-c",
            stmt,
        )

    def ctl(self, cmd):
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(3)
            sock.connect(str(self.root / "admin.sock"))
            sock.sendall((cmd + "\n").encode())
            sock.shutdown(socket.SHUT_WR)
            chunks = []
            while data := sock.recv(65536):
                chunks.append(data)
        return b"".join(chunks).decode().strip()

    def change(self, command):
        result = self.ctl(command)
        if (
            result
            and result != "nothing changed"
            and not result.startswith(
                ("IP changed", "no need to change the addr", "New port")
            )
        ):
            raise RuntimeError(command + ": " + result)

    def stats(self, slot):
        lines = self.ctl("show stat").removeprefix("# ").splitlines()
        return next(
            row
            for row in csv.DictReader(lines)
            if row["pxname"] == "booking" and row["svname"] == slot
        )

    def url(self, svc, port):
        return "http://" + self.dc("port", svc, str(port)).splitlines()[0]

    def image(self, svc):
        return run(["docker", "inspect", "-f", "{{.Image}}", self.dc("ps", "-q", svc)])

    def gate(self, opened):
        self.change("add acl virt@pickup open" if opened else "clear acl virt@pickup")

    def migrate(self, label):
        return self.job(label, "dist/database/command.js", "migrate")

    def job(self, label, *args):
        return self.dc(
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "job",
            "node",
            *args,
            override={"JOB_IMAGE": self.env[label + "_IMAGE"]},
        )

    def login(self, base, account, password):
        status, body, _ = http(
            base, "POST", "/v1/auth/login", {"login": account, "password": password}
        )
        if status != 200:
            raise RuntimeError(f"Login failed: {status}")
        return body["accessToken"]

    def probe(self, base, label):
        try:
            if label == "NEW":
                return http(base, "GET", "/health/ready")[0] == 200
            token = self.login(base, "employee-a", self.env["SEED_PASSWORD_A"])
            return http(base, "GET", "/v1/equipment", token=token)[0] == 200
        except (OSError, URLError, RuntimeError):
            return False

    def start_slot(self, slot, label, override=None):
        svc = "slot-" + slot
        self.dc(
            "up",
            "-d",
            "--no-deps",
            "--force-recreate",
            svc,
            override={
                slot.upper() + "_IMAGE": self.env[label + "_IMAGE"],
                **(override or {}),
            },
        )
        if self.image(svc) != self.env[label + "_ID"]:
            raise RuntimeError("Unexpected image in " + svc)
        return self.url(svc, 3000)

    def admit(self, slot):
        cid = self.dc("ps", "-q", "slot-" + slot)
        ip = run(
            [
                "docker",
                "inspect",
                "-f",
                "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
                cid,
            ]
        )
        self.change("set server booking/" + slot + " addr " + ip)
        self.change("set server booking/" + slot + " state ready")
        eventually(lambda: self.stats(slot)["status"] == "UP")

    def drain(self, slot):
        self.change("set server booking/" + slot + " state drain")
        eventually(lambda: int(self.stats(slot)["scur"]) == 0, timeout=15)
        self.change("set server booking/" + slot + " state maint")

    def replace(self, slot, label):
        other = "b" if slot == "a" else "a"
        if self.stats(other)["status"] != "UP":
            raise RuntimeError("Peer is not ready; refusing to drain " + slot)
        self.drain(slot)
        base = self.start_slot(slot, label)
        eventually(lambda: self.probe(base, label))
        self.admit(slot)
        self.env[slot.upper() + "_IMAGE"] = self.env[label + "_IMAGE"]
        self.save()

    def worker(self, label):
        self.dc(
            "up",
            "-d",
            "--no-deps",
            "--force-recreate",
            "worker",
            override={"WORKER_IMAGE": self.env[label + "_IMAGE"]},
        )
        if self.image("worker") != self.env[label + "_ID"]:
            raise RuntimeError("Unexpected worker image")
        eventually(
            lambda: "Notification worker ready"
            in self.dc("logs", "--no-log-prefix", "worker")
        )
        self.env["WORKER_IMAGE"] = self.env[label + "_IMAGE"]
        self.save()

    def init(self):
        self.dc("up", "-d", "--wait", "db", "proxy")
        self.migrate("OLD")
        self.job("OLD", "dist/database/command.js", "seed")
        self.job("OLD", "dist/notifications/process.js", "configure")
        for svc in ("receiver-a", "receiver-b"):
            self.dc(
                "run",
                "--rm",
                "--no-deps",
                "-T",
                svc,
                "node",
                "dist/notifications/receiver.js",
                "migrate",
            )
        self.dc("up", "-d", "--no-deps", "receiver-a", "receiver-b")
        for slot in "ab":
            base = self.start_slot(slot, "OLD")
            eventually(lambda: self.probe(base, "OLD"))
            self.admit(slot)
        self.worker("OLD")

    def rollout(self, label):
        self.gate(False)
        if label == "NEW":
            self.migrate(label)
        slots = sorted("ab", key=lambda slot: self.stats(slot)["status"] == "UP")
        for slot in slots:
            if (
                self.stats(slot)["status"] == "UP"
                and self.image("slot-" + slot) == self.env[label + "_ID"]
            ):
                continue
            peer = "b" if slot == "a" else "a"
            if (
                label == "NEW"
                and self.stats(slot)["status"] == "UP"
                and self.image("slot-" + peer) == self.env["NEW_ID"]
            ):
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if any(self.stats(name)["status"] != "UP" for name in (slot, peer)):
                        raise RuntimeError(
                            "A mixed-version instance lost readiness; release paused"
                        )
                    time.sleep(0.25)
            self.replace(slot, label)
        self.worker(label)
        self.gate(label == "NEW")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", choices=["init", "upgrade", "rollback", "redeploy", "status", "down"]
    )
    parser.add_argument("--state", required=True)
    parser.add_argument(
        "--purge",
        action="store_true",
        help="Remove the isolated database volume and control files on down",
    )
    parser.add_argument("--old", default=OLD_DRILL_REVISION)
    parser.add_argument("--new", default=NEW_DRILL_REVISION)
    args = parser.parse_args()
    if args.purge and args.action != "down":
        parser.error("--purge is only valid with down")
    stage = (
        Stage.create(args.state, args.old, args.new)
        if args.action == "init"
        else Stage(args.state)
    )
    if args.action == "init":
        stage.init()
    elif args.action == "down":
        stage.dc(
            "--profile",
            "drill",
            "--profile",
            "jobs",
            "down",
            "--remove-orphans",
            *(["--volumes"] if args.purge else []),
        )
        if args.purge:
            stage.file.unlink()
            (stage.root / "admin.sock").unlink(missing_ok=True)
            stage.root.rmdir()
    elif args.action == "status":
        print(
            json.dumps(
                {
                    "url": stage.url("proxy", 8080),
                    "images": {
                        svc: stage.image(svc) for svc in ["slot-a", "slot-b", "worker"]
                    },
                    "slots": {slot: stage.stats(slot)["status"] for slot in "ab"},
                }
            )
        )
    else:
        stage.rollout("OLD" if args.action == "rollback" else "NEW")
