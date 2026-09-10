# Six-hour Oracle receiver audit

The latest candidate completed the entire six-hour observation from 2026-09-09 17:55:57.192 UTC to 2026-09-09 23:55:57.193 UTC (14:55:57–20:55:57 São Paulo). Receiver, PCM, polling, event, and checkpoint coverage is complete. It is **not an uninterrupted-audio pass**.

| Measurement | Result |
|---|---:|
| Receiver / PCM coverage | 21,599.9996 s / 21,600.0107 s |
| Positive / negative loss-counter changes | +64 / −71 packets |
| Discarded packets / NACKs | 380 / 1,161 |
| Concealed audio | 51.615 s total; 32.234 s silent |
| Quiet intervals >=100 ms needing review | 8 (6 off-boundary, 2 extended boundary) |
| Longest quiet interval | 15.624 s |
| PCM clipping / nonfinite / empty frames | 0 / 0 / 0 |
| Stale polls / missing PCM reports / browser long tasks | 0 / 0 / 0 |
| Oracle bot restarts / send failures / source overruns | 0 / 0 / 0 |
| Oracle PSS during run | 16.041–17.041 MiB; median 16.396 MiB |
| Oracle CPU | 3.98% of one core |
| Oracle UDP/interface errors and cgroup memory events | 0 |
| Checkpoint saves / errors during run | 362 / 0 |

The positive and negative cumulative loss-counter changes sum to −7. Negative changes are corrections and may cover losses before this observation; they do not prove that all 64 newly reported losses were recovered. Of 375 checkpoint saves in the collected file, 362 belong to this six-hour run (matched by requestedAt). The error counter did not increase. No clipping, invalid PCM, empty frames, browser long tasks, stale polls, or missing PCM reports occurred.

## Incident correlation

At 20:50:57 UTC the receiver stopped receiving audio. ICE and peer connection changed to `disconnected` at 20:51:03.213 and returned to `connected` at 20:51:12.087. The quiet interval was 14.826 seconds. Oracle sender checkpoints continued at the expected pacing, with no increase in unavailable frames, skipped deadlines, send failures, or source overruns. Oracle UDP counters, interface errors/drops, CPU/memory pressure, and cgroup memory events were clean. This incident is strongly localized to the receiver voice transport path after the sender; one receiver cannot identify the failing hop.

At 23:47:08.717 UTC a second quiet interval began without an ICE or connection transition and lasted 15.624 seconds. Track generation 103 had started at 23:43:36.257 UTC but produced no logged natural `TrackEnd`; generation 104 began at 23:47:24.296 UTC at the time predicted by Raydio's duration-plus-15-second end watchdog (the old binary did not log this trigger). The source has about 0.94 seconds of natural quiet at its end: this incident began at that expected tail, then extended it by roughly 14.7 seconds. The visible player position lagged real playback and cannot establish that the gap began mid-song.

A focused regression now reproduces a Crust race: a GET snapshot sees Mantle at EOF and clears the public track before SourceTerminal publishes TrackEndEvent. That event then lacks userData/raydioGeneration. Raydio correctly rejects an unidentifiable event, leaving the loop waiting for its watchdog. The race also disables periodic player refreshes, explaining the missing diagnostic window without proving a blocked actor. The queued event loses generation 103 before the patch and retains it after. This mechanism fits the live incident closely, although the old recording lacks the event payload needed to prove that specific occurrence directly. See [../eof-race-20260910/RESULTS.md](../eof-race-20260910/RESULTS.md) for implementation and validation.

The five other off-boundary quiet intervals lasted 1,154, 365, 330, 301, and 481 ms. Their exact causes are unresolved; no measured Oracle pressure or sender failure explains them, and one-second network/minute host samples cannot exclude brief disturbances. The 1,136 ms boundary interval also remains flagged because it exceeds the reference tail plus the analyzer's explicit 100 ms tolerance. Ordinary recurring ~976 ms tails agree in timing and duration with the independently measured source tail; that is a candidate classification, not a fresh waveform match.

## Memory and reliability interpretation

Warm PSS stayed roughly 15.81–17.04 MiB (median 16.40 MiB). The first warm five samples had a 15.96 MiB median and the last five 17.00 MiB. This small increase had no cgroup pressure or OOM event and is insufficient to call a leak; it may be allocator/cache growth. It remains well inside the 128 MiB high and 256 MiB max limits. A heap profile or repeated longer run is needed to prove whether it plateaus.

The diagnostics are trustworthy for coverage and correlation, but this run does not establish perfect audio. A second independent receiver is needed to distinguish shared Discord/sender incidents from the local receiver route. The reproduced Crust event-identity race can be fixed without changing the watchdog or transport. A fresh five-minute receiver test validates ordinary playback and a loop, but cannot establish absence of the rare receiver transport incident. No Opus, DAVE, bitrate, or encryption change is justified by these measurements.

Raw collected files are retained under `target/controls-six-hour-20260909/collected`. At collection Testbot was PID 6744; production Raydio was inactive and disabled. These are historical states, not a claim about the current deployment. Scheduled maintenance was restored after the observation.
