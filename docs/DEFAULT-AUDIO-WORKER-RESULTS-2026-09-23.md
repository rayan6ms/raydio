# Default-worker comparison: interrupted run, September 23

**This was not a successful six-hour playback run.** The receiver recorded 54 minutes 34.688 seconds (15.16% of the requested window). Oracle continued sending after the receiver failed, then a separate DAVE readiness timeout ended bot playback. We obtained useful diagnostics and a short matched comparison, but cannot claim a six-hour default-versus-worker result or select a production winner from this run.

## What happened

All timestamps below are UTC; subtract three hours for Brasília.

| Time, September 23 | Evidence |
|---|---|
| 02:30:49.945 | Receiver recording began; default build, experimental worker disabled. |
| Approximately 03:25:08.6 | Last receiver poll containing packets; subsequent polls received none. |
| 03:25:15.339 | Browser ICE connection became disconnected. |
| 03:25:25.336 | Browser peer failed; its recording finalized at 03:25:25.636. |
| 03:27:22.196 | Oracle successfully started another natural song loop after receiver failure. |
| 03:27:31.284 | DAVE opcode 24 reset active version 1 to 0/not-ready; opcode 21 left a transition pending. Last traced packet was at 03:27:31.274. |
| 03:27:41.285 | Ten-second DAVE readiness deadline expired: `DaveTransition`, `ResponseTimeout`, `retry: Fatal`. Raydio cleared playback and posted its voice-connection-closed message. |
| 08:30:52.944 | Receiver supervisor ended as `completed-with-gaps`. Only its first segment obtained audio; 31 subsequent preflight attempts found no advancing receiver. |
| 10:32:11.863 | Guarded evidence export began, over two hours after the planned recording end. No export/compression intrusion during measurement. |

The sender trace advances across the receiver failure. Thus the later bot timeout cannot explain the **initial** receiver outage. The local observer had no long tasks, no missing PCM reports and no host-sampling suspension; its longest independent sampling interval was 61.005 seconds. There was no browser `network-offline` event, which does not rule out an upstream outage while the local interface stayed up.

At collection, this machine's public IPv4 had changed and was absent from Oracle's SSH allowlist. Oracle still reported the original Always Free instance RUNNING at the same address. Adding only the current administrator's TCP/22 `/32`, preserving existing rules with ETag protection, restored SSH. This supports investigating the listener's network path but does **not** timestamp the IP change or establish a Starlink reboot as the cause. A Discord/voice-path failure remains possible.

The later bot failure is confirmed, not merely missing diagnostics: pinned Oto `e7dd066` starts a ten-second readiness deadline in `gateway.rs` when DAVE is not ready and classifies expiry as fatal. Pinned `dave.rs::prepare_epoch` resets the backend and active version on a new initial epoch. The recorded opcode 24/21 sequence matches that path. `ResponseTimeout` here does not establish that an encryption callback took ten seconds; the gateway readiness watchdog uses the same error classification. The logs do not establish why readiness never returned, whether all required protocol messages arrived, or whether this followed listener departure/rejoin.

## Matching the first 54 minutes

These prefixes precede the receiver outage and avoid the worker run's contaminated final seconds. Trace windows are exactly 3,240 seconds. Receiver minute buckets cover 3,239.631 seconds for default and 3,239.450 seconds for worker; rates account for their actual durations. Resource deltas cover the interior minute samples.

| Metric | Worker enabled, preceding run | Worker disabled, this run |
|---|---:|---:|
| Raw sender gaps ≥40 ms | 61 | 85 |
| Raw sender gaps ≥100 ms | 0 | 4 |
| Maximum sender gap | 82.319 ms | 110.886 ms |
| Net lost packets | 0 | 0 |
| Positive loss deltas, subsequently corrected | 3 | 30 |
| Concealed audio | 3.874 s | 7.313 s |
| Concealment rate | 71.75 ms/min | 135.44 ms/min |
| Silent concealment | 0.095 s | 1.772 s |
| Off-boundary quiet intervals ≥100 ms | 0 | 3, totaling 1.714 s |
| Source-unavailable / silence frames | 2 / 2 | 0 / 0 |
| Send failures / source overruns | 0 / 0 | 0 / 0 |
| Median bot PSS | 15.828 MiB | 16.411 MiB |
| Bot CPU, one-core equivalent | 4.174% | 3.814% |
| Mean host CPU steal | 0.406% | 0.409% |

The default prefix had **39.3% more raw gaps and 88.8% more concealment**, while using less CPU. There was no net packet-loss advantage either way. Positive loss deltas capture temporary missing/late delivery that net totals conceal; they are not a count of permanent losses. Quiet classification retains natural song tails separately, using the existing historical reference with its provenance limitation. No clipping-threshold hit, non-finite PCM or empty PCM frame was recorded before the receiver failed.

### Why this does not prove a worker benefit

Forty default gaps occurred in the single minute 02:33:10–02:34:10, when Oracle host CPU steal reached **5.52%**. Thirty-eight of these gaps had wake lateness over 20 ms. The worst 110.886 ms gap included **89.736 ms waiting for the DAVE owner**, but only **14 microseconds of measured DAVE work**. Source polling never exceeded 2.263 ms in the prefix. This points to scheduling/wait delays, not a slow media callback, as the main observed stall mechanism; minute-level steal cannot prove the cause of each individual packet delay.

The distribution matters: first five minutes had 48 default gaps versus 13 worker gaps; the following 49 minutes had **37 default versus 48 worker**. This is a sensitivity check, not permission to discard the bad minute. The apparent ranking changes across subwindows. Neither a definitive worker improvement nor a worker regression follows from this single sequential pair, especially with a fresh default process and warm worker process.

## Collector and coverage checks

- Same Oracle PID `58789`, no service restart. Production Raydio stayed inactive. Testbot's process is still online, but playback stopped at the DAVE failure; being online is not evidence of playing.
- All 32 terminal receiver attempts were archived. Three transient persistence/rearm checks were recorded, but the original failed segment survives. The other attempts failed because they observed no advancing receiver; they are not 31 additional playback disconnections.
- Oracle resource collector produced 421 samples without sampler errors; the local host collector produced 415. Empty kernel capture, no recorded bot OOM/restart. Maintenance timers were restored and are enabled.
- Prefix collector CPU: **0.04320%** of one core default versus **0.04445%** worker. No collector OOM, memory-limit event or missing collector in either prefix. This is not the earlier repeated-full-export interference pattern.
- No missing trace indices, RTP sequence jumps, RTP timestamp jumps or traced silence packets in the default measured sender interval. Successful sends establish local submissions, not delivery to the listener.
- Do not use six-hour CPU averages to claim a performance gain: most of this run was idle after playback stopped. Likewise, there is no six-hour receiver-loss total.
- The first segment's 24.127 seconds of concealment includes the outage tail; the matched table deliberately reports the preceding 54-minute prefix. The full failed segment remains preserved, including its 17.363-second terminal quiet interval.

## Decision and next work

Keep the worker experimental. The current evidence does not justify rejecting it, promoting it, or declaring default superior. The corrected append-only collector worked and should remain.

The most useful next engineering work is **DAVE transition recovery**, before another unattended six-hour attempt: reproduce the recorded epoch-reset/prepare-transition sequence with listener departure/rejoin; record sanitized transition identifiers, readiness state and outbound acknowledgement/key-package progress; distinguish protocol-readiness expiry from owner-request expiry; then test bounded reconnect/re-identification that retains the queue and resumes only after a valid encrypted session is ready. Do not bypass encryption readiness or merely remove the timeout. Any recovery must avoid reconnect loops and preserve failed-run evidence.

A short departure/rejoin and interrupted-network qualification is more informative now than repeating the unchanged six-hour test. Once recovery is demonstrated, compare worker/default with the same warm-up and repeated equal-duration windows, retaining scheduling/steal measurements. A repeatable difference is needed before attributing the observed gap totals to the worker architecture.

No audio code, bot deployment, playback restart or production promotion was performed during this results review.

## Reproduction and preserved evidence

Run directory: `evidence/default-worker-stream-20260923/six-hour/`. The guarded uncompressed Oracle export, all receiver segments, host samples and append-only event/window history remain local. `first-segment/receiver.json` is a copy of the original terminal audio segment; the top-level `receiver.json` remains the final failed preflight and was not overwritten.

```sh
uv run --no-project python evidence/default-worker-stream-20260923/six-hour/analyze_comparison.py
uv run --no-project python benchmarks/summarize_receiver.py \
  --input evidence/default-worker-stream-20260923/six-hour/first-segment \
  --output evidence/default-worker-stream-20260923/six-hour/first-segment/summary.json \
  --source-tail-ms 938.458333
```

See `comparison.json`, `qualification.json`, `export-guard.json`, `receiver-session.json`, and `SHA256SUMS` for identities, timing, detailed counts and artifact integrity. The inherited source reference is historical; it is not a fresh waveform-equivalence measurement.
