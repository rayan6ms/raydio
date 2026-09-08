"""Fetch the pinned Testbot candidate, then replace Python with native Rust."""
import hashlib
import os
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request

URL = "https://github.com/rayan6ms/raydio/releases/download/v0.2.2-rc.1/raydio-linux-x86_64.tar.gz"
ARCHIVE_SHA256 = "340d269f8a5dabe3e1a87c91a0b4bfbf78295a92f63d740fabf72818fceef9f1"
BINARY_SHA256 = "4e1deea5c1179edb92f0ec6eb708ed67fdd73ce83ea19750b7b26539b2ad8ac3"
ROOT = Path(__file__).resolve().parent
BINARY = ROOT / "raydio-native"


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            result.update(chunk)
    return result.hexdigest()


if platform.machine() not in ("x86_64", "AMD64"):
    raise SystemExit("This test candidate requires x86_64")
if not BINARY.exists() or digest(BINARY) != BINARY_SHA256:
    print("Downloading checksum-pinned Rust Testbot candidate", flush=True)
    with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
        archive_path = Path(temporary) / "release.tar.gz"
        with urllib.request.urlopen(URL, timeout=60) as response, archive_path.open("wb") as output:
            total = 0
            while chunk := response.read(65536):
                total += len(chunk)
                if total > 30 * 1024 * 1024:
                    raise RuntimeError("Release archive exceeds expected size")
                output.write(chunk)
        if digest(archive_path) != ARCHIVE_SHA256:
            raise RuntimeError("Release archive checksum mismatch")
        candidate = Path(temporary) / "raydio"
        with tarfile.open(archive_path, "r:gz") as archive:
            members = [m for m in archive.getmembers() if m.name in ("bin/raydio", "./bin/raydio")]
            if len(members) != 1:
                raise RuntimeError("Expected exactly one native binary archive member")
            member = members[0]
            if not member.isfile() or member.size > 30 * 1024 * 1024:
                raise RuntimeError("Invalid native binary archive member")
            with archive.extractfile(member) as source, candidate.open("wb") as output:
                while chunk := source.read(65536):
                    output.write(chunk)
        if digest(candidate) != BINARY_SHA256:
            raise RuntimeError("Native binary checksum mismatch")
        candidate.chmod(0o700)
        candidate.replace(BINARY)
os.environ.setdefault("MALLOC_ARENA_MAX", "2")
os.environ.setdefault("RAYDIO_WORKER_THREADS", "2")
os.chdir(ROOT)
print("Starting native Rust Testbot", flush=True)
os.execve(str(BINARY), [str(BINARY), "--testbot"], os.environ)
