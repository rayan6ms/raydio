# Append-only collector run: six-hour results — September 23

**The collector correction produced substantially better observed results.** The complete receiver recording has no disconnection, failed segment, missing PCM interval or clipping-threshold hit. It remains imperfect audio, and the last 8.74 seconds were disturbed by an evidence export that I started prematurely. Those seconds remain in every full-run total below.

Do not reject the audio-worker candidate based on the earlier fivefold sender-gap increase: that result was heavily contaminated by repeated full-journal exports. This run supports keeping the corrected collector. It does not isolate a benefit of the worker over the default implementation, nor prove a network-loss fix.

## Coverage and identities

Measurement: **September 22 19:37:48.268 UTC–September 23 01:37:48.328 UTC**, or **16:37–22:37 Brasília**. Receiver counters cover 21,599.999984 seconds; PCM covers 21,600.010667 seconds. One segment completed, no rearm occurred, and every receiver coverage flag is true. All 310 diagnostic windows were recovered from persistence, including the 54 evicted from the bounded in-browser ring. Event, phase, speaking and independent host/checkpoint coverage are complete. The automated analyzer raised no coverage warnings.

The bot binary, process (PID 53299), detailed trace configuration, source, volume 70 and Loop remained unchanged from the preceding candidate run. Collector changes are commit `23b0478` on `experiment/queued-audio-worker`, confirmed published. The candidate is still experimental. Raydio remained inactive; Testbot had no restart. No automatic promotion, rollback or additional test was performed during this review.

## Comparison

| Metric | Previous candidate, repeated full exports | Same candidate, append-only capture | September 12 default baseline |
|---|---:|---:|---:|
| Receiver duration | 6 h | **6 h** | 6 h |
| Receiver disconnection episodes | 3 | **0** | 2 |
| Received packets | 1,076,798 | 1,079,293 | 1,079,253 |
| Net lost packets | 189 | **8** | 198 |
| Discarded packets | 444 | **327** | 440 |
| NACKs | 1,881 | **1,357** | 1,499 |
| Concealed audio | 79.236 s | **25.509 s** | 33.161 s |
| Concealment rate | 220.10 ms/min | **70.86 ms/min** | 92.11 ms/min |
| Silent concealment | 9.555 s | **3.009 s** | 6.493 s |
| Raw trace gaps ≥40 ms, full six hours | 1,263 | **287** | trace disabled |
| Active-timeline gaps ≥40 ms, interior 359-minute checkpoints | 1,263; 211.09/hour | **218; 36.43/hour** | 233; 38.94/hour |
| Raw trace gaps ≥100 ms / ≥1 s | 2 / 0 | **0 / 0** | counters 0 / 0 |
| Source-unavailable / silence frames, interior checkpoints | 0 / 0 | **2 / 2** | 1 / 1 |
| Send failures / source overruns | 0 / 0 | **0 / 0** | 0 / 0 |
| Median bot PSS | 16.591 MiB | **15.828 MiB** | 16.994 MiB |
| Bot CPU, one-core equivalent | 4.173% | **4.102%** | 4.056% |
| Host CPU steal | 0.715% | **0.307%** | 0.326% |

Full-run changes against the previous candidate: raw gaps **−77.3%**, concealment **−67.8%**, silent concealment **−68.5%**, net lost packets **−95.8%**, discarded packets **−26.4%**, NACKs **−27.9%**. These describe the measured observations, not confidence intervals or guarantees. Network conditions and VM scheduling varied; especially the loss reduction cannot be assigned solely to collection changes.

Eight net losses are **0.000741%** of received-plus-lost packets. Positive loss deltas totaled **116**, followed by **−108** in corrections; net loss is not a complete count of every late/lost delivery incident. Concealment means decoder-generated replacement audio, not necessarily silence. The trace contains 1,079,299 local submissions, including two silence packets; it is not interchangeable with receiver arrival counts.

Memory was 15.828–15.961 MiB PSS. No bot code/memory optimization occurred between these observations; shared-page accounting and process state can affect PSS. Do not claim this as an isolated memory optimization.

## Collector cost and integrity

Across 359 sampled minutes, the bot-log follower consumed **7.196 CPU seconds** and the kernel follower **2.171 CPU seconds**, a combined **0.04348% of one core**. The bot log advanced at every minute sample (319,535 → 112,131,719 bytes). Both collector cgroups remained populated, with no sampler error or OOM kill. No kernel warning was captured during the observation. The full packet trace has zero missing indices, dropped ring records, RTP sequence jumps or RTP timestamp jumps.

The bot-log collector's cgroup charge reached its **64 MiB limit**, with **230 memory.max events** but no OOM event/kill. A post-run memory.stat snapshot showed approximately 1 MiB anonymous memory and 13.6 MiB file cache; that later snapshot does not establish the exact mix at peak. File-cache charging/reclaim is a remaining collector-overhead consideration. Continuous output and low CPU show it did not repeat the former growing CPU bursts, but do not prove zero interference. Kernel collector memory stayed 2.33–2.91 MiB. These charges are separate from bot PSS.

Maintenance restoration and final collector cleanup were still scheduled for approximately **02:36 UTC**, one hour after measurement, when this review began. Do not treat their pending state as a failed restoration. Testbot remains active and Raydio inactive. The immutable post-window snapshot was copied at 01:38:23 UTC for analysis; routine collectors continue to their bounded lifetime.

### Trace/counter reconciliation

The interior checkpoint interval contains 222 raw trace gaps versus 218 active-timeline counter gaps. The four additional intervals (51.755–68.950 ms) are followed by records with `scheduled=0`, indicating the source-start path rather than a scheduled deadline. Oto resets `last_packet_sent` when pausing its timeline, so the active-timeline counter and all-packet trace intentionally have different scopes. Removing those four from that diagnostic cross-check gives exactly 218; all four remain in the raw-gap totals. Their specific readiness/transport transition cause was not established from the available logs.

This is distinct from a sub-millisecond checkpoint snapshot/log-publication timing difference, which can move a single gap between adjacent minute buckets without changing the interval total. `qualification.json` preserves the records and reconciliation. The base analyzer's raw mismatch remains explicit rather than silently rewritten as equality.

## Remaining audible issues and the premature export

There were **eight mid-track quiet intervals ≥100 ms**, totaling **2.786 seconds**, maximum **542 ms**. The prior candidate had 29 intervals totaling 6.976 seconds, maximum 711 ms. No clipping, non-finite samples or empty frames were detected; peak remained 0.5683. Natural tails remain separately classified: 192 source-tail candidates and ten boundary intervals overlapping anomalies. No extended-boundary quiet was flagged. The 938 ms tail reference remains historical, not fresh waveform alignment.

I began the first `tar -czf` evidence download at **01:37:39.529 UTC**, before checking that the recorder's actual completion had occurred. The six-hour end was **01:37:48.268 UTC**. This is an avoidable analysis error, recorded in Oracle's sudo journal, not an event caused by the user.

During that **8.739-second overlap**:

- **60 of the 287** full-window raw sender gaps occurred.
- **Four of the eight** ≥100 ms mid-track quiet intervals occurred, totaling **1.465 seconds**.
- All these incidents are retained in full-run results; zero missing recording time does not mean zero measurement interference.

Before export, the observed window was **21,591.261 seconds** (5 h 59 min 51 s), with **227 raw gaps**, **37.85/hour**, and four ≥100 ms mid-track quiet intervals totaling **1.322 seconds**. This separately labeled prefix helps diagnose the intrusion; it is not a substitute six-hour pass or a counterfactual estimate. The comparable 359-minute checkpoint interval ends at 01:37:01 UTC and excludes the export automatically, so its 36.43/hour rate must not be presented as the full six-hour all-packet rate.

The two reported unavailable-source/silence frames and four unscheduled-start gaps remain visible. They are small but prevent a claim of perfect source continuity. Thirteen browser long tasks (943 ms total; maximum 208 ms) were recorded; polling and PCM coverage still passed. No evidence proves all remaining incidents are bot defects or all are network problems.

## Conclusion

The growing full-journal exporter was a major problem. Replacing it removed the repeated degradation pattern and lowered total collector cost to about nine CPU seconds across six hours. This strongly supports the diagnosis from the previous run. The short compression intrusion at the end provides further evidence that expensive evidence handling can disturb this VM.

Keep append-only capture, retain the experimental worker for further assessment, and do not infer a worker regression from the contaminated earlier runs. Before any future evidence export, require both the scheduled deadline to have passed **and** the receiver session to be terminal; compression must happen after measurement. Review the collector's cache-limit events as a smaller remaining instrumentation concern.

For deciding whether the worker itself belongs in production, the remaining useful experiment is a matched default/candidate comparison with identical lightweight diagnostics. Another unmatched overnight repetition is less informative. This review does not claim production readiness under a strict zero-interruption requirement, despite the large operational improvement.

## Evidence and reproduction

[Evidence directory](../evidence/queued-worker-stream-20260922/six-hour/) contains receiver/session files, archived events/windows, Oracle snapshot, resources and analyses. `collection-lifecycle.log` independently timestamps the premature export. `SHA256SUMS` fingerprints source artifacts. The large compressed archive and raw logs remain local.

```sh
uv run --no-project python benchmarks/summarize_receiver.py \
  --input evidence/queued-worker-stream-20260922/six-hour \
  --output evidence/queued-worker-stream-20260922/six-hour/summary.json \
  --source-tail-ms 938.458333
uv run --no-project python evidence/queued-worker-stream-20260922/six-hour/analyze_run.py
uv run --no-project python evidence/queued-worker-stream-20260922/six-hour/qualification.py
```
