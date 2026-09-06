"""Bounded, low-CPU 20 ms scheduler probe, independent of Discord or media.

Run with uv run --no-project locally, or Python's standard library on the VM.
This measures Python/OS wakeups, not the Rust pacer or network transmission.
"""
import json
import statistics
import time

period = 0.020
started = time.monotonic()
deadline = started + period
late = []
gaps = []
previous = started
while time.monotonic() - started < 60:
    time.sleep(max(0, deadline - time.monotonic()))
    now = time.monotonic()
    late.append(max(0, now - deadline) * 1000)
    gaps.append((now - previous) * 1000)
    previous = now
    deadline += period
    if deadline <= now:
        deadline = now + period

print(json.dumps({
    "scope": "60-second independent Python time.sleep scheduler probe; no media or Discord, no busy wait and no catch-up loop",
    "elapsedSeconds": time.monotonic() - started,
    "samples": len(late),
    "latenessMs": {"median": statistics.median(late), "p99": sorted(late)[int(len(late)*.99)], "max": max(late)},
    "intervalMs": {"max": max(gaps), "over25": sum(g > 25 for g in gaps), "over40": sum(g > 40 for g in gaps)},
    "lateEvents": [{"sample": i, "lateMs": v} for i, v in enumerate(late) if v > 5][:100]
}, indent=2))
