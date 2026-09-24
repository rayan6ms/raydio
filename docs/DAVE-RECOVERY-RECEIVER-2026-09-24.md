# Receiver qualification and later sender run — 2026-09-24

The user-started loop playback remained active on Oracle after the receiver recorder completed. The saved receiver measurement covered **five minutes**, from `09:58:10.867Z` through `10:03:10.918Z`; it did not cover six hours. The later journal supports a six-hour **sender-only** observation from `09:58:10.867Z` through `15:58:10.867Z`.

## Five-minute receiver result

The browser receiver had one uninterrupted segment with complete poll, PCM, event, speaking-indicator, and track-phase coverage. It received 15,000 RTP packets and reported:

- network lost packets: **0**;
- positive cumulative-loss deltas: **0**;
- discarded packets: **4** and NACKs: **12**;
- concealed audio: **6,710 samples = 139.79 ms**, across 9 events;
- silent concealed audio: **0 ms**;
- PCM empty/non-finite/near-full-scale frames: **0 / 0 / 0**;
- longest PCM quiet interval: **976.25 ms**;
- receiver and PCM durations: **299.999 s / 300.011 s**.

The quiet classifier found two intervals (20.08 ms and 976.25 ms). Both are `source-tail-candidate`: they align with the known 938.46 ms encoded tail and a generation-1 finish followed 1.482 ms later by generation-2 start. The 976.25 ms interval is therefore consistent with the normal loop boundary, with no overlapping receiver anomaly. This is a conservative attribution, not proof from waveform alignment; it is not an off-boundary interruption. The source reference is reused from the same URL and volume and is documented as prior provenance.

During the receiver window, sender checkpoints showed 12,000 frames, zero unavailable or silence frames, zero skipped deadlines, zero send failures, zero source overruns, and zero active send gaps at 40 ms, 100 ms, or 1 s. Oracle PSS samples in the window were 15.55–15.63 MiB (median 15.55 MiB); CPU was 4.02% of one core. No cgroup memory events or UDP kernel errors occurred.

## Six-hour sender-only result

The retained Oracle service journal contains 1,079,415 traced submissions over six hours, with no malformed batches, ring drops, RTP sequence jumps, timestamp jumps, or process changes. It records 101 track starts and 101 finishes. Sender-side totals are:

| Metric | Result |
|---|---:|
| gaps ≥40 ms | 247 (41.17/hour) |
| gaps ≥100 ms | 1 |
| largest gap | 243.381 ms |
| explicit silence records | 4 |
| unavailable frames | 4 |
| skipped deadlines | 436 |
| send failures / source overruns | 0 / 0 |

The largest gap occurred at `10:25:27.276Z` and is marked unscheduled in the trace (`scheduled=0`), so it is a sender scheduling/source-availability event, not evidence of a Discord packet loss. The sender journal cannot establish what a listener heard. In particular, there is no receiver packet-loss, concealment, PCM, clipping, or audible-silence measurement for the remaining five hours and 55 minutes.

The sender journal continued to show the Testbot process alive without terminal failures or restarts. Raydio remained stopped and disabled. Testbot remains the only bot process on the Oracle VM.

## Conclusion

The measured five-minute receiver segment passed the current audio-continuity checks: no lost packets, no silent concealment, no clipping/non-finite PCM, and no off-boundary quiet interval. The later six-hour sender journal is useful for identifying scheduler gaps, but it cannot be used to claim six-hour receiver quality. The single 243 ms unscheduled sender gap and 436 skipped-deadline count warrant future investigation if they recur; this run does not justify changing the transport based on receiver evidence because the receiver was no longer recording.

Evidence and machine-readable summaries are in `evidence/dave-watchdog-20260924/receiver-20260924-0926/` and `evidence/dave-watchdog-20260924/later-sender/`.
