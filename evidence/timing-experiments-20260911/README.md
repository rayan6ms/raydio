# Sender timing experiments, September 11–12, 2026

These recordings compare the existing pacer with diagnostic instrumentation and
two pacing experiments. All use the same track, volume 70, stereo Opus, and the
existing Oracle instance. Trace-disabled recordings are the acceptance evidence;
trace-enabled recordings locate delays and verify RTP continuity.

| Folder | Pacer | Per-packet trace | Binary SHA-256 |
|---|---|---|---|
| baseline-off | Original | off | `225a2af42cbb9639394db8f0d40d0eb0ae897e81ade62c50e36dfd0ac79a9d91` |
| diagnostic-on | Original, new timing instrumentation | on | `b9227a911592028f046f1332630435da4dfce11ed7a5ca2f93fce1889096677a` |
| recovery-on | 18 ms spacing, bounded recovery debt | on | `e5d10b5441ec5faf709f4645f5a701187587b01eb47c13030f49924f73535015` |
| baseline-off2 | Original, new timing instrumentation | off | `b9227a911592028f046f1332630435da4dfce11ed7a5ca2f93fce1889096677a` |
| narrow-off-resume | 10 ms minimum spacing after sub-period delays | off | `10be7e273fdf889c3975f6a91548d58aca38e3b1b2373591b580b83cadf17ed5` |

The first baseline overlapped a bounded local release build. A roughly three-hour
agent interruption separates baseline-off2 and narrow-off-resume. No candidate
receiver audit ran during that interruption. The expired collectors were renewed
before the measured candidate window. Sequential measurements cannot exclude
host/network variation; do not treat a single difference as a causal improvement.

`invalid/` preserves three operator-caused setup failures. One command was sent
while the bot was offline; another run was explicitly stopped at 207 seconds;
the first matched baseline omitted Loop and the song ended. None qualifies as
a completed comparison or demonstrates a spontaneous bot/Discord failure.

`service.log.gz` is the journal captured from the receiver's start. Traced runs
also have `full-service.txt.gz`, which starts at process launch so record numbers
can be checked from 1. Diagnostic timestamps measure local UDP submission, not
delivery. Stage wall time can include descheduling and does not itself measure
CPU cost. DAVE owner CPU time is included separately.

The source reference is a reused September 10 independent source measurement,
not a fresh waveform alignment of every loop. Boundary quiet with an overlapping
transport anomaly is retained for review. The receiver files contain signal
statistics and WebRTC counters, not a raw PCM recording or a listening verdict.

From the repository root, compare completed runs with:

```sh
uv run --no-project python benchmarks/compare_delivery_trials.py \
  evidence/timing-experiments-20260911/baseline-off2 \
  evidence/timing-experiments-20260911/narrow-off-resume
```

To regenerate a receiver summary, first decompress `service.log.gz` to
`service.log` in a temporary copy of the run folder, then use
`benchmarks/summarize_receiver.py --input FOLDER --output SUMMARY --source-tail-ms 938.458`.
Sender rates use the interior checkpoint duration; receiver rates use the full
receiver duration. Neither duration is assumed to equal the other.
