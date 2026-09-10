# Ten-minute Oracle receiver qualification

The September 9 candidate completed this ten-minute receiver qualification.
This report preserves that result separately from the later six-hour observation.

| Ten-minute observation | Result |
|---|---:|
| Received packets | 29,982 |
| Packet loss (net and positive deltas) | 0 |
| Discarded packets / NACKs | 13 / 33 |
| Concealed audio | 808.04 ms (80.80 ms/min) |
| Silent concealment | 0 ms |
| Clipped / nonfinite / empty PCM samples or frames | 0 |
| Unexpected quiet intervals >=100 ms | 0 |
| Connection events / stale polls / missing PCM reports | 0 |
| Oracle bot PSS | 15.81–16.02 MiB; median 15.96 MiB |
| Oracle bot CPU | 4.02% of one core |

The two ~976 ms quiet tails align with track restarts. Independent source
analysis previously measured ~938 ms of source-tail silence. This is temporal
classification, not a new waveform alignment or proof of zero handoff delay.
Speaking-off transitions in this window occurred only at the source tails.
Sender minute checkpoints spanning nine minutes show one unavailable/silence
frame and nine skipped deadlines; send failures and source overruns are zero.
Host UDP errors and cgroup memory events were zero. Receiver coverage was
complete, with three diagnostic windows retained and none dropped.

Residual concealment remains. These observations do not prove a reduction in
network faults or memory versus an earlier run, and a short qualification is
not a six-hour pass. The previously demonstrated fixes preserve audio across
redundant controls; this quiet live window does not retest button latency.

## Related long observation

The separate six-hour observation is complete. Its corrected results and
manifest are in [../controls-six-hour-20260909/RESULTS.md](../controls-six-hour-20260909/RESULTS.md).
Raw short-window files are preserved under `target/controls-live-20260909`.
