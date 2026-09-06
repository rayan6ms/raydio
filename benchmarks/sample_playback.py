"""Read-only whole-stack sampling during verified live playback.

Run with uv run --no-project. Pass every bot/backend PID; this script never
starts or stops a process and rejects unexpected executables.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import statistics
import time


def sample(pids, expected_exe=None):
    total = dict(rssKiB=0, pssKiB=0, cpuSeconds=0, threads=0)
    for pid in pids:
        root = Path(f"/proc/{pid}")
        executable = (root / "exe").resolve()
        if (expected_exe is not None and executable != expected_exe.resolve()) or (expected_exe is None and executable.name not in ("raydio", "node", "java")):
            raise RuntimeError("Unexpected sampled executable")
        stat = (root / "stat").read_text().split(") ", 1)[1].split()
        total["cpuSeconds"] += (int(stat[11]) + int(stat[12])) / os.sysconf("SC_CLK_TCK")
        total["threads"] += int(stat[17])
        for line in (root / "smaps_rollup").read_text().splitlines():
            if line.startswith("Rss:"):
                total["rssKiB"] += int(line.split()[1])
            elif line.startswith("Pss:"):
                total["pssKiB"] += int(line.split()[1])
    return total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, action="append", required=True)
    parser.add_argument("--stack", required=True)
    parser.add_argument("--workload", default="One live Discord voice session, dQw4w9WgXcQ, volume 70, track loop, panel refresh enabled")
    parser.add_argument("--expected-exe", type=Path)
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = {
        "date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "stack": args.stack,
        "workload": args.workload,
        "limitations": ["Shared host", f"{args.trials} consecutive windows in one warmed process; not independent process restarts", "Human listening confirmation recorded separately"],
        "processCount": len(args.pid),
        "executables": [{"name": Path(f"/proc/{pid}/exe").resolve().name,
                         "sha256": hashlib.file_digest(Path(f"/proc/{pid}/exe").open("rb"), "sha256").hexdigest()}
                        for pid in args.pid],
        "trials": [],
    }
    for trial in range(args.trials):
        initial = sample(args.pid, args.expected_exe)
        started = time.monotonic()
        observations = []
        while time.monotonic() - started < args.seconds:
            time.sleep(1)
            observations.append(sample(args.pid, args.expected_exe))
        elapsed = time.monotonic() - started
        cpu = observations[-1]["cpuSeconds"] - initial["cpuSeconds"]
        row = dict(trial=trial + 1, observationSeconds=round(elapsed, 3),
                   medianRssKiB=statistics.median(s["rssKiB"] for s in observations),
                   medianPssKiB=statistics.median(s["pssKiB"] for s in observations),
                   cpuSeconds=round(cpu, 3), cpuPercentOneCore=round(cpu / elapsed * 100, 3),
                   maxThreads=max(s["threads"] for s in observations))
        result["trials"].append(row)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(row), flush=True)


if __name__ == "__main__":
    main()
