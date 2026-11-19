"""Build both releases with the same recipe and source files from a specific Git commit."""
import argparse
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]

def build(revision, client=False):
    sha = subprocess.check_output(["git", "rev-parse", "--verify", revision + "^{commit}"], cwd=ROOT, text=True).strip()
    files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".node-version", "tsconfig.json",
             "tsconfig.build.json", "nest-cli.json", "clients", "docs/openapi.json", "test/integration/contract.mjs", "src"]
    with tempfile.TemporaryDirectory(prefix="booking-build-") as tmp:
        archive = pathlib.Path(tmp) / "source.tar"
        subprocess.run(["git", "archive", "-o", str(archive), sha, "--", *files], cwd=ROOT, check=True)
        subprocess.run(["tar", "-xf", str(archive), "-C", tmp], check=True)
        archive.unlink()
        shutil.copyfile(ROOT / "deploy/Dockerfile", pathlib.Path(tmp) / "Dockerfile")
        targets = ["release", "contract-client"] if client else ["release"]
        for target in targets:
            subprocess.run(["docker", "build", "--target", target, "--build-arg", "REVISION=" + sha,
                            "-t", f"booking-{target}:{sha}", tmp], check=True)
    return sha

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("revision")
    parser.add_argument("--client", action="store_true")
    args = parser.parse_args()
    print(build(args.revision, args.client))
