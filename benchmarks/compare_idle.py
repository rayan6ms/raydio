"""Compare complete authenticated idle bots. Run with uv run --no-project.

Uses only DISCORD_TOKEN_TESTBOT. Runs one stack at a time and terminates only
the Popen instances it owns. Raw child logs and credentials are never saved.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import statistics
import subprocess
import tempfile
import threading
import time
import urllib.request


class Process:
    def __init__(self, command, cwd, env, markers=()):
        self.seen = set()
        self.markers = markers
        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, text=True)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in self.process.stdout:
            for marker in self.markers:
                if marker in line:
                    self.seen.add(marker)

    def wait_ready(self, deadline):
        while not all(marker in self.seen for marker in self.markers):
            if self.process.poll() is not None:
                raise RuntimeError(f"Owned process exited with code {self.process.returncode}")
            if time.monotonic() > deadline:
                missing = [marker for marker in self.markers if marker not in self.seen]
                raise RuntimeError(f"Owned process readiness timed out; missing markers: {missing}")
            time.sleep(0.05)

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.reader.join(timeout=1)

    def sample(self):
        root = Path(f"/proc/{self.process.pid}")
        stat = (root / "stat").read_text().split(") ", 1)[1].split()
        memory = {}
        for line in (root / "smaps_rollup").read_text().splitlines():
            if line.startswith(("Rss:", "Pss:")):
                key, value, _ = line.split()
                memory[key[:-1]] = int(value)
        return {"rssKiB": memory["Rss"], "pssKiB": memory["Pss"],
                "cpuSeconds": (int(stat[11]) + int(stat[12])) / os.sysconf("SC_CLK_TCK"),
                "threads": int(stat[17])}


def sample(processes):
    samples = [process.sample() for process in processes]
    return {key: sum(item[key] for item in samples) for key in samples[0]}


def summarize(trials):
    return {
        stack: {
            key: statistics.median(item[key] for item in trials if item["stack"] == stack)
            for key in ("startupMs", "medianRssKiB", "medianPssKiB", "cpuPercentOneCore", "maxThreads")
        }
        for stack in ("rust", "original-tuned", "original-default")
    }


def run_trial(args, stack, token):
    env = {key: value for key, value in os.environ.items() if key not in ("APPIMAGE", "APPDIR", "ARGV0")}
    env.update(DISCORD_TOKEN=token, DISCORD_TOKEN_TESTBOT=token, LOG_LEVEL="info")
    processes = []
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="raydio-idle-") as work:
        work = Path(work)
        try:
            if stack.startswith("original"):
                with socket.socket() as listener:
                    listener.bind(("127.0.0.1", 0))
                    port = listener.getsockname()[1]
                password = secrets.token_hex(32)
                env.update(LAVALINK_SERVER_PASSWORD=password, LAVALINK_PASSWORD=password,
                           LAVALINK_HOST="127.0.0.1", LAVALINK_PORT=str(port), LAVALINK_SECURE="false")
                config = (args.original / "lavalink/application.yml").read_text()
                config = config.replace("port: 2333", f"port: {port}").replace("address: 0.0.0.0", "address: 127.0.0.1")
                (work / "application.yml").write_text(config)
                (work / "plugins").mkdir()
                shutil.copyfile(args.crust / ".cache/reference/ecosystem-youtube/1.18.2/youtube-plugin-1.18.2.jar",
                                work / "plugins/youtube-plugin-1.18.2.jar")
                heap = ["-Xms64m", "-Xmx192m", "-XX:ActiveProcessorCount=2"] if stack.endswith("tuned") else ["-Xmx512m"]
                java = Process([str(args.java), *heap, "-jar", str(args.crust / ".cache/reference/4.2.2/Lavalink.jar")], work, env, ["Lavalink is ready"])
                processes.append(java)
                java.wait_ready(started + 60)
                bot = Process([str(args.node), str(args.original / "dist/index.js")], work, env,
                              ['"event":"discord_ready"', '"event":"lavalink_ready"', '"event":"application_commands_ready"'])
            else:
                bot = Process([str(args.binary), "--testbot"], work, env, ["Raydio ready"])
            processes.append(bot)
            bot.wait_ready(started + 80)
            ready = time.monotonic()
            time.sleep(args.warmup)
            initial = sample(processes)
            before = time.monotonic()
            observations = []
            while time.monotonic() - before < args.seconds:
                time.sleep(1)
                observations.append(sample(processes))
            elapsed = time.monotonic() - before
            final = observations[-1]
            return {"stack": stack, "startupMs": round((ready - started) * 1000, 2),
                    "observationSeconds": round(elapsed, 3),
                    "medianRssKiB": statistics.median(item["rssKiB"] for item in observations),
                    "medianPssKiB": statistics.median(item["pssKiB"] for item in observations),
                    "maxThreads": max(item["threads"] for item in observations),
                    "cpuSeconds": round(final["cpuSeconds"] - initial["cpuSeconds"], 3),
                    "cpuPercentOneCore": round((final["cpuSeconds"] - initial["cpuSeconds"]) / elapsed * 100, 3)}
        finally:
            for process in reversed(processes):
                process.stop()


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--original", type=Path, default=root.parent / "raydio")
    parser.add_argument("--crust", type=Path, default=root.parent / "crust")
    parser.add_argument("--binary", type=Path, default=root / "target/release/raydio")
    parser.add_argument("--node", type=Path, default=shutil.which("node"))
    parser.add_argument("--java", type=Path, default="/opt/adoptium/temurin-25/bin/java")
    parser.add_argument("--seconds", type=int, default=15)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--output", type=Path, default=root / "evidence/idle-performance.json")
    args = parser.parse_args()
    for name in ("env_file", "original", "crust", "binary", "node", "java", "output"):
        setattr(args, name, getattr(args, name).resolve())
    token = next(line.partition("=")[2].strip().strip("\"'") for line in args.env_file.read_text().splitlines() if line.startswith("DISCORD_TOKEN_TESTBOT="))
    request = urllib.request.Request("https://discord.com/api/v10/users/@me", headers={
        "Authorization": "Bot " + token,
        "User-Agent": "DiscordBot (https://github.com/rayan6ms/raydio, 0.2.0)",
    })
    with urllib.request.urlopen(request, timeout=10) as response:
        if json.load(response)["id"] != "1544468432907669644":
            raise RuntimeError("Refusing to benchmark an unexpected bot")
    result = {"date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "workload": "Authenticated idle, no voice session or commands", "trials": [],
              "limitations": ["Idle only; no playback or interaction latency claim", "Shared host, warm OS caches",
                              "Original default profile has a 512 MiB Java heap safety cap; tuned profile uses 64–192 MiB and two active processors"],
              "node": subprocess.check_output([str(args.node), "--version"], text=True).strip(),
              "reference": {"lavalink": "4.2.2", "youtubePlugin": "1.18.2"},
              "binaryBytes": args.binary.stat().st_size,
              "binarySha256": hashlib.file_digest(args.binary.open("rb"), "sha256").hexdigest(),
              "revisions": json.loads((root / "evidence/revisions.json").read_text()),
              "warmupSeconds": args.warmup}
    for trial in range(args.trials):
        order = ["rust", "original-tuned", "original-default"]
        order = order[trial % 3:] + order[:trial % 3]
        for stack in order:
            print(f"Starting trial {trial + 1}: {stack}", flush=True)
            record = run_trial(args, stack, token)
            record["trial"] = trial + 1
            result["trials"].append(record)
            args.output.write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(record), flush=True)
            time.sleep(3)
    result["mediansAcrossTrials"] = summarize(result["trials"])
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
