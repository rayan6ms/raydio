# Six-hour Oracle receiver audit

The latest candidate completed the entire six-hour observation from 2026-09-09 17:55:57.192 UTC to 2026-09-09 23:55:57.193 UTC (14:55:57–20:55:57 São Paulo). Receiver, PCM, polling, event, and checkpoint coverage is complete. It is **not an uninterrupted-audio pass**.

| Measurement | Result |
|---|---:|
| Receiver / PCM coverage | 21,599.9996 s / 21,600.0107 s |
| Positive loss / recovered loss | 64 / 71 packets |
| Discarded packets / NACKs | 380 / 1,161 |
| Concealed audio | 51.615 s total; 32.234 s silent |
| Unexpected quiet intervals >=100 ms | 6 |
| Longest quiet interval | 15.624 s |
| PCM clipping / nonfinite / empty frames | 0 / 0 / 0 |
| Stale polls / missing PCM reports / browser long tasks | 0 / 0 / 0 |
| Oracle bot restarts / send failures / source overruns | 0 / 0 / 0 |
| Oracle PSS during run | 16.041–17.041 MiB; median 16.396 MiB |
| Oracle CPU | 3.98% of one core |
| Oracle UDP/interface errors and cgroup memory events | 0 |
| Checkpoint saves / errors during run | 375 / 0 |

The 64 positive loss packets and 71 recovered packets explain the negative net counter delta; that delta is not negative loss. No clipping, invalid PCM, empty frames, browser long tasks, stale polls, or missing PCM reports occurred.

## Incident correlation

At 20:50:57 UTC the receiver stopped receiving audio. ICE and peer connection changed to `disconnected` at 20:51:03.213 and returned to `connected` at 20:51:12.087. The quiet interval was 14.826 seconds. Oracle sender checkpoints continued at the expected pacing, with no increase in unavailable frames, skipped deadlines, send failures, or source overruns. Oracle UDP counters, interface errors/drops, CPU/memory pressure, and cgroup memory events were clean. This incident is strongly localized to the receiver voice transport path after the sender; one receiver cannot identify the failing hop.

At 23:47:08.717 UTC a second quiet interval began without an ICE or connection transition and lasted 15.624 seconds. Track generation 103 had started at 23:43:36.257 UTC but produced no logged natural `TrackEnd`; generation 104 began at 23:47:24.296 UTC when Raydio's 15-second end watchdog fired. The Oracle sender checkpoint spanning the incident advanced only 2,700 frames where roughly 3,450 would be expected, and its audio entered `WaitingForSource`; unavailable frames increased by five, while send failures and source overruns remained zero. This is strong evidence of a sender-side media handoff/source-terminal stall, rather than network loss. The evidence does not isolate whether the stall is in Mantle's finite decoder/read, Crust's source-terminal event delivery, or the Oto source bridge. The watchdog amplified it into an audible gap; lowering that watchdog alone would reduce the gap but could cut slow tracks and is not a complete fix.

The remaining concealment and four shorter non-tail quiet events are distributed network delivery or buffering artifacts. They are not explained by Oracle CPU, memory, UDP errors, sender overruns, or browser scheduling. The approximately 0.94-second end-of-track tails align with the independently measured source tail and are classified separately from the two incidents above.

## Memory and reliability interpretation

Warm PSS stayed roughly 15.81–17.04 MiB (median 16.40 MiB). The first warm five samples had a 15.96 MiB median and the last five 17.00 MiB. This small increase had no cgroup pressure or OOM event and is insufficient to call a leak; it may be allocator/cache growth. It remains well inside the 128 MiB high and 256 MiB max limits. A heap profile or repeated longer run is needed to prove whether it plateaus.

The diagnostics are trustworthy for coverage and correlation, but this run does not establish perfect audio. A second independent receiver is needed to distinguish shared Discord/sender incidents from the local receiver route. The source-handoff incident needs a focused Crust/Mantle/Oto reproduction with terminal/read timing before changing the watchdog or transport. No Opus, DAVE, bitrate, or encryption change is justified by these measurements.

Raw collected files are retained under `target/controls-six-hour-20260909/collected`. Oracle Testbot remains online as PID 6744; production Raydio remains inactive and disabled. Scheduled maintenance restoration remains bounded and automatic.
