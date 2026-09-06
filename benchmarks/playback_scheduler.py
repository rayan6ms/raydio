"""Bounded read-only Linux scheduling probe alongside one owned test bot.

20 ms sleeps measure independent wakeups; per-second task schedstat and host
CPU counters distinguish runnable delay from CPU work. No tracing or payloads.
"""
import argparse
import json
from pathlib import Path
import time

parser = argparse.ArgumentParser()
parser.add_argument("--pid", type=int, required=True)
parser.add_argument("--seconds", type=int, default=150)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
if not 1 <= args.seconds <= 600:
    parser.error("seconds must be 1..600")
root = Path(f"/proc/{args.pid}")
executable = (root / "exe").resolve()
if executable.name not in ("raydio", "testbot-release"):
    parser.error("unexpected executable")


def snapshot():
    tasks = {}
    for task in (root / "task").iterdir():
        try:
            values = list(map(int, (task / "schedstat").read_text().split()))
            tasks[task.name] = dict(name=(task / "comm").read_text().strip(),
                                    runtimeNs=values[0], runnableNs=values[1], slices=values[2])
        except FileNotFoundError:
            pass
    cpu = list(map(int, Path("/proc/stat").read_text().splitlines()[0].split()[1:]))
    return dict(monoNs=time.monotonic_ns(), tasks=tasks, cpuTicks=cpu,
                cpuPressure=Path("/proc/pressure/cpu").read_text().strip())


started = time.monotonic_ns()
report = dict(scope="Independent 20 ms sleeper alongside playback; aggregate per-second Linux scheduler counters, not a causal proof", pid=args.pid,
              executable=str(executable), startedUnixNs=time.time_ns(), startedMonoNs=started,
              snapshots=[snapshot()], lateEvents=[], samples=0, maxIntervalMs=0, maxLatenessMs=0,
              intervalsOver25=0, intervalsOver40=0)
period = 20_000_000
deadline = previous = started
next_snapshot = started + 1_000_000_000
while time.monotonic_ns() - started < args.seconds * 1_000_000_000:
    deadline += period
    time.sleep(max(0, deadline - time.monotonic_ns()) / 1e9)
    now = time.monotonic_ns()
    late = max(0, now - deadline) / 1e6
    gap = (now - previous) / 1e6
    report["samples"] += 1
    report["maxIntervalMs"] = max(report["maxIntervalMs"], gap)
    report["maxLatenessMs"] = max(report["maxLatenessMs"], late)
    report["intervalsOver25"] += gap > 25
    report["intervalsOver40"] += gap > 40
    if late > 5 and len(report["lateEvents"]) < 500:
        report["lateEvents"].append(dict(monoNs=now, latenessMs=late, intervalMs=gap))
    previous = now
    if now >= next_snapshot:
        report["snapshots"].append(snapshot())
        next_snapshot = now + 1_000_000_000
    if deadline <= now - period:
        deadline = now
report["snapshots"].append(snapshot())
report["elapsedSeconds"] = (time.monotonic_ns() - started) / 1e9
args.output.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({key: value for key, value in report.items() if key not in ("snapshots", "lateEvents")}))
