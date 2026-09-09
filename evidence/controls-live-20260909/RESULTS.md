# Latest candidate: ten-minute qualification and six-hour observation

The September 9 candidate completed a ten-minute receiver qualification. The
six-hour observation began at 17:55:57.192 UTC (14:55:57 São Paulo), scheduled to
finish at 23:55:57.192 UTC (20:55:57 São Paulo). Its result is pending.

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

## Run safeguards and collection

Testbot PID 6744 runs the candidate identified in `six-hour-run.json`. Production
Raydio is inactive/disabled, and no other Raydio process is running on Oracle.
The native x86-64/ARM64 CI workflow 34376525370 succeeded. Browser control uses
the user-authorized T3 integration; the earlier browser blocker is resolved.

Playback remains at volume 70 with Loop enabled on the same live receiver.
No bot restart, control interaction, build, or Oracle SSH administration is
planned during measurement. Automatic independent minute samples record Oracle
resources and local receiver-host pressure/network counters. Browser diagnostics
record WebRTC delivery/concealment, PCM quality, connection and scheduling events,
and bounded incident windows. Only aggregate diagnostics are retained, not PCM.

The checkpoint preflight verified the actual advancing six-hour report, at least
two independent host samples, and sufficient recorder lifetime. One checkpoint
error predates both valid observations; use the error delta from that baseline.
A systemd sleep inhibitor and local collector persist independently of the agent.
Oracle scheduled package/firmware maintenance was paused with bounded restoration.
A final Oracle log snapshot is scheduled after the receiver window. Testbot is
left running; neither final capture nor sampler expiry stops playback.

Raw short-window files are preserved under `target/controls-live-20260909`;
long-window receiver files remain under `target/receiver-controls-20260909`.
The run manifest records remote evidence locations and timer deadlines.
Before interpreting the final run, verify report completion, elapsed coverage,
checkpoint continuity, dropped diagnostic windows, independent host coverage,
bot PID/restarts, and source-tail alignment. A single receiver cannot identify
the exact failing network hop or guarantee absence of external disturbances.
