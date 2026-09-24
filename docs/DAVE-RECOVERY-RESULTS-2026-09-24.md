# Recovery candidate: six-hour sender observation, September 24

The encrypted-voice recovery and track-end watchdog fixes have useful live evidence. This is **not a six-hour receiver audio-quality qualification**: no browser receiver recorder was active during the user-started playback. Receiver packet loss, concealment, clipping and audible quiet cannot be reconstructed from sender submissions.

## Run identity and scope

Testbot alone ran on Oracle, PID 62921, experimental audio worker disabled. Production Raydio remained inactive and disabled. The final binary SHA-256 is `49553da476b6e312d56378691b71b8a1121a7caa32e535b41bac2ca806fce85d`; it includes the additional `src/session.rs` watchdog fix. Oto is `e84d316e`, Crust `617da27a`.

An initial single-track trial began at 21:30:12 UTC and ended at 21:33:45. The user then started playback with Loop. The exact six-hour analysis window is **September 23 21:34:01.148473 UTC to September 24 03:34:01.148473 UTC** (18:34–00:34 Brasília). A new sender epoch identifies this start; the first single-track trial is excluded. At the first inspection, six hours had not elapsed, so collection was allowed to continue.

## Measured results

| Metric | Six-hour sender window |
|---|---:|
| Traced UDP submissions | 1,077,621 |
| Raw gaps ≥40 ms | 307 |
| Active-sending gaps ≥40 ms | 306 (51/hour of wall time) |
| Active-sending gaps ≥100 ms | 1; maximum 100.022 ms |
| Separate empty-room encryption wait | 32.687 seconds |
| Missing trace records / malformed batches / ring drops | 0 / 0 / 0 |
| RTP sequence / timestamp discontinuities | 0 / 0 |
| Natural track completions | 101 |
| Process restarts / bot OOM kills | 0 / 0 |
| UDP error/buffer-drop counter increase | 0 |
| PSS median / maximum | 16.99 / 17.42 MiB |
| Bot CPU, one-core equivalent | 3.86% |
| Host CPU steal, mean | 0.33% |

Resource figures use 359 interior minute samples, spanning 21,481 seconds; no sampler error, longest sample interval 60.008 seconds. PSS includes proportional shared memory; it is not interchangeable with service cgroup MemoryPeak. The last pre-cleanup sender checkpoint had zero send failures and source overruns, and one unavailable frame represented by one silence packet. No source exception, readiness timeout, end-watchdog advance or automatic service restart appeared in this candidate run.

The largest active gap at 03:13:26 had 79.935 ms of wake lateness; DAVE round-trip was 29 microseconds and source polling two microseconds. The enclosing host minute had 5.13% CPU steal. That supports scheduler contention as a contributor, not a proof of the cause of each gap. A late send is not necessarily a lost packet or an audible interruption.

## The recovery actually exercised

At 02:37:05.743714 UTC Discord sent a client-disconnect event. The new initial epoch reset DAVE readiness, and the confirmed empty roster activated the bounded 120-second wait. At 02:37:38.279389 membership returned; encrypted readiness returned at 02:37:38.419420 and a packet was submitted at 02:37:38.419492. There was no fresh-handshake retry or terminal cleanup. The source stayed generation 86 (Raydio track generation 88).

The retained song naturally completed at 02:40:05.801743, approximately 245.7 seconds after its start: its normal ~213-second duration plus the membership wait. The bot did not apply the old 228-second wall-clock deadline and prematurely skip the song. Subsequent loops continued. This directly supports both the bounded empty-room fix and the playback-progress watchdog fix.

The 32.687-second transmission gap remains in the raw totals. It is not song-tail silence, and it is not evidence that a connected listener heard 32 seconds of silence. Server membership evidence does not explain whether the listener left intentionally, reloaded Discord, or suffered a network interruption. There is no receiver recording to answer that question.

## Comparison with the prior default-worker run

For the first 54 minutes after the looping sender epoch:

| Metric | Previous default worker | Current candidate |
|---|---:|---:|
| Sender gaps ≥40 ms | 85 | 28 |
| Sender gaps ≥100 ms | 4 | 0 |
| Maximum gap | 110.886 ms | 59.955 ms |
| Median PSS | 16.41 MiB | 16.81 MiB |
| Bot CPU | 3.81% | 3.85% |
| Host CPU steal | 0.409% | 0.245% |

The gap count is 67.1% lower in this observed prefix, with slightly more memory. Lower host steal and separate runs prevent attributing that reduction to code. The recovery changes primarily address lifecycle failures, not steady-state UDP packet loss. The previous worker-enabled prefix had 61 gaps; these new sender-only data do not settle the worker decision.

## Collection limitations and corrections

- The browser had no endurance observer at inspection; the local attempted receiver directories contain host samples or failed preflight reports, not a completed receiver recording. Earlier commentary saying the five-minute measurement was running was premature: it failed preflight because the preceding candidate had stopped sending.
- The first sender snapshot/export began at **02:59:31.610587 UTC**, inside the last 35 minutes of the eventual six-hour window. It ran at low priority without compression, but observer impact is still possible. The final period cannot be called a clean, untouched benchmark. Waiting until six hours afterwards does not remove that limitation. The first54-minute comparison precedes this export.
- The journal collector reached its 64 MiB memory cap at 00:51 UTC, accumulating 167 `memory.events:max` entries by 02:59. It had no OOM kill or missing trace record. This warrants measuring collector anonymous/file memory and reclaim pressure before another long test; it does not itself prove a bot leak or explain the gaps. Combined journal/kernel collector CPU averaged ~0.044% of a core.
- No local build or bot restart occurred inside the selected six-hour window. Finalization and the accidental manual Testbot stop happened after it. Maintenance masks were restored. Testbot was brought back online as PID 64293, **idle**; that stop ended playback. Raydio stayed disabled. The manual post-window restart is not part of the zero-restart measurement.

## Next qualification and operating rule

Keep the fixes; do not promote the experimental worker or claim improved receiver packet loss from this dataset. Next useful check: a short receiver measurement with durable checkpoints verified before extending to endurance. The user will submit `/play https://youtu.be/dQw4w9WgXcQ` and enable Loop when instrumentation is ready. **Do not try to submit playback commands or toggle Loop automatically.** Do not restart/stop Testbot after declaring a test ready, or during collection/export cleanup. Check the exact deadline before any bulk export.

## Reproduction

Evidence root: `evidence/dave-watchdog-20260924/`. Raw Oracle records and archives remain local; the compact qualified summary and analyzer are committed. `SHA256SUMS` binds the final source records. The original preliminary snapshot is retained separately.

```sh
nice -n 15 uv run --no-project python evidence/dave-watchdog-20260924/analyze_sender.py \
  --source final-sender --start 2026-09-23T21:34:01.148473Z \
  --seconds 21600 --output six-hour-summary.json
```

The streaming analyzer retains a 32.687-second gap in its raw counts, validates continuity within each transport epoch, and never interprets missing diagnostic indices as missing audio. Its raw event list includes setup/finalization; window metrics use explicit timestamps. The compact summary separately classifies the empty-room wait from lifecycle evidence.
