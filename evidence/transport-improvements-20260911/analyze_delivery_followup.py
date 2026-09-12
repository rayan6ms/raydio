"""Reproduce coarse incident associations; this does not establish causality.

Run with: uv run --no-project python evidence/transport-improvements-20260911/analyze_delivery_followup.py
Uses only the retained September 11 evidence, without contacting either host.
"""
from collections import defaultdict
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import statistics

ROOT = Path(__file__).resolve().parent
RUN = ROOT / "transport-rerun-20260911"
NAMES = ("sender-six-hour-summary.json", "resources.jsonl", "receiver.json")
sender = json.loads((RUN / NAMES[0]).read_text())
resources = [json.loads(line) for line in (RUN / NAMES[1]).read_text().splitlines()]
receiver = json.loads((RUN / NAMES[2]).read_text())


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def pressure(row):
    return int(re.search(r"total=(\d+)", row["pressure"]["cpu"])[1])


intervals = []
for before, after in zip(resources, resources[1:]):
    begin, end = timestamp(before["utc"]), timestamp(after["utc"])
    assert end > begin and before["pid"] == after["pid"]
    ticks = [b - a for a, b in zip(before["cpuTicks"], after["cpuTicks"])]
    assert all(t >= 0 for t in ticks[:8]) and sum(ticks[:8]) > 0
    intervals.append({
        "begin": begin, "end": end,
        # guest and guest_nice (indices 8/9) already occur in user/nice.
        "stealPercent": 100 * ticks[7] / sum(ticks[:8]),
        "cpuPressurePercent": 100 * (pressure(after) - pressure(before)) / ((end - begin) * 1e6),
        "botCpuPercent": 100 * (after["cpuSeconds"] - before["cpuSeconds"]) / (end - begin),
    })

assert not receiver["eventsTruncated"] and receiver["eventsDropped"] == 0
events = [e for e in receiver["events"] if e["kind"] == "receiver"]
groups = defaultdict(lambda: defaultdict(float))
for event in events:
    group = ("positiveLoss" if event["lost"] > 0 else
             "discardWithoutPositiveLoss" if event["discarded"] > 0 else
             "neitherPositiveLossNorDiscard")
    groups[group]["eventPolls"] += 1
    for key in ("concealedMs", "silentConcealedMs", "lost", "discarded"):
        groups[group][key] += event[key]
concealed_ms = sum(g["concealedMs"] for g in groups.values())
assert math.isclose(concealed_ms, receiver["delta"]["concealedSamples"] * 1000 / receiver["sampleRate"])
assert sum(g["lost"] for g in groups.values()) == receiver["delta"]["packetsLost"]
assert sum(g["discarded"] for g in groups.values()) == receiver["delta"]["packetsDiscarded"]
start = timestamp(receiver["startedAt"])
receiver_end = start + receiver["elapsedSeconds"]
rows = []
for before, after in zip(sender["senderCheckpoints"], sender["senderCheckpoints"][1:]):
    begin, end = timestamp(before["utc"]), timestamp(after["utc"])
    assert 59 < end - begin < 61
    overlaps = [(max(0, min(end, r["end"]) - max(begin, r["begin"])), r) for r in intervals]
    overlaps = [(seconds, r) for seconds, r in overlaps if seconds > 0]
    coverage = sum(seconds for seconds, r in overlaps)
    assert math.isclose(coverage, end - begin, abs_tol=0.001)
    row = {key: sum(seconds * r[key] for seconds, r in overlaps) / coverage
           for key in ("stealPercent", "cpuPressurePercent", "botCpuPercent")}
    nearest = min(intervals, key=lambda r: abs((r["begin"] + r["end"]) - (begin + end)))
    row["nearestMidpointStealPercent"] = nearest["stealPercent"]
    row.update(begin=before["utc"], end=after["utc"])
    for key in ("active_send_gaps_40ms", "frames_unavailable"):
        row[key] = after[key] - before[key]
        assert row[key] >= 0
    # Only fully recorded receiver intervals can contain a meaningful zero.
    row["receiverCounterCoverage"] = start <= begin and end <= receiver_end
    row["concealedMs"] = row["positiveLoss"] = None
    if row["receiverCounterCoverage"]:
        selected = [e for e in events if begin < start + e["ms"] / 1000 <= end]
        row["concealedMs"] = sum(e["concealedMs"] for e in selected)
        row["positiveLoss"] = sum(max(0, e["lost"]) for e in selected)
    rows.append(row)
assert sum(r["active_send_gaps_40ms"] for r in rows) == sender["senderDelta"]["active_send_gaps_40ms"]

grouped = {}
for label, subset in (("gapMinutes", [r for r in rows if r["active_send_gaps_40ms"]]),
                      ("gapFreeMinutes", [r for r in rows if not r["active_send_gaps_40ms"]])):
    grouped[label] = {"minutes": len(subset), **{
        key: {"mean": statistics.mean(r[key] for r in subset),
              "median": statistics.median(r[key] for r in subset)}
        for key in ("stealPercent", "cpuPressurePercent", "botCpuPercent", "nearestMidpointStealPercent")}}

result = {
    "scope": "Read-only analysis of September 11 rerun; no new live measurement or code change",
    "inputs": {name: hashlib.sha256((RUN / name).read_bytes()).hexdigest() for name in NAMES},
    "senderSeconds": sender["senderSeconds"],
    "receiverSeconds": receiver["elapsedSeconds"],
    "receiverEventGroups": dict(groups),
    "concealmentWithoutPositiveLossPercent": 100 * (concealed_ms - groups["positiveLoss"]["concealedMs"]) / concealed_ms,
    "minuteGroups": grouped,
    "descriptivePearsonCorrelationWithGapCount": {
        key: statistics.correlation([r["active_send_gaps_40ms"] for r in rows], [r[key] for r in rows])
        for key in ("stealPercent", "cpuPressurePercent", "botCpuPercent", "nearestMidpointStealPercent")},
    "minuteRows": rows,
    "limitations": [
        "Resource counters are minute averages. Overlap weighting assumes uniform increments within each resource interval.",
        "Nearest-midpoint pairing is a sensitivity check; neither pairing resolves individual stalls.",
        "Descriptive correlation is not causal attribution or a test of statistical significance; adjacent minutes may be dependent.",
        "Receiver events are assigned by polling endpoint, not exact packet/PCM incident time; cross-host clock error is not measured here.",
        "Same-poll loss/discard/concealment groups do not establish causes. Corrections, reordering, and decoder effects may lag.",
        "Receiver coverage ended at 65 minutes 55 seconds; later receiver minute values are null, never inferred clean.",
    ],
}
output = ROOT / "delivery-followup-20260911.json"
output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
print(json.dumps({"output": str(output), "minutes": len(rows), "groups": grouped,
                  "concealmentWithoutPositiveLossPercent": result["concealmentWithoutPositiveLossPercent"]}, indent=2))
