# Final six-hour Oracle comparison — 2026-09-12

The final candidate completed the requested 21,600-second receiver observation on Oracle with Testbot playing the pinned track in `test → General`, volume 70, Loop on. Receiver, PCM, polling, event, speaking, and track-phase coverage were complete. The isolated Testbot had no process restart, sender failure, source overrun, DAVE failure, or maintenance interruption. Production `raydio.service` stayed disabled. The isolated service and sampler were stopped after preservation, and Oracle maintenance and snap refresh were restored.

## Comparison with the previous complete six-hour run

| Metric | Previous complete run | Final run | Change |
|---|---:|---:|---:|
| Receiver / PCM coverage | 21,600 s / 21,600 s | 21,600 s / 21,600 s | equal |
| Packets received | 1,078,984 | 1,079,253 | +0.02% |
| Net lost packets | 47 | 198 | +321% |
| Loss rate | 0.00436% | 0.01834% | +0.01399 pp |
| Discarded packets | 567 | 440 | −22% |
| NACKs | 2,074 | 1,499 | −28% |
| Concealment | 46,066 ms | 33,161 ms | −28% |
| Concealment rate | 127.96 ms/min | 92.11 ms/min | −28% |
| Silent concealment | 13,509 ms | 6,493 ms | −52% |
| Sender gaps ≥40 ms | 228 (38.11/hour) | 233 (38.94/hour) | +2.2% |
| Sender gaps ≥100 ms / ≥1 s | 0 / 0 | 0 / 0 | equal |
| Sender unavailable/silence frames | 6 | 1 | lower |
| Send failures / source overruns | 0 / 0 | 0 / 0 | equal |
| Bot PSS median | 16.646 MiB | 16.994 MiB | +2.1% |
| Bot PSS range | 16.298–16.696 MiB | 16.104–17.279 MiB | slightly higher |
| Bot CPU | 4.004% | 4.056% | +1.3% |
| Host CPU steal | 0.386% | 0.326% | lower |
| PCM peak / near-full-scale / non-finite | 0.573 / 0 / 0 | 0.568 / 0 / 0 | clean |

The final run is a valid six-hour measurement, but it is not a flawless-audio pass: `uninterruptedConnection` is false because the receiver observed two short ICE/connection `disconnected → connected` episodes. The receiver also recorded several mid-track packet/concealment bursts. The largest positive-loss polls were 118 packets with 550 ms concealment, 54 packets with 942 ms concealment, and 32/24 packets with about 981/866 ms concealment. The sender continued sending during those periods, with zero send failures and zero source overruns. This points to delivery-path/Discord-WebRTC behavior or a downstream route problem rather than a reproduced source or sender termination bug; one receiver cannot identify the exact network hop.

The two ICE transitions recovered in roughly 34 ms and 38 ms and do not line up exactly with the largest packet bursts. They therefore provide evidence of transient transport instability, not a complete causal explanation. No Oracle UDP receive-buffer, send-buffer, checksum, OOM, cgroup-memory, kernel-warning, or maintenance-unit errors were observed during the window.

The natural track boundary remains separately classified. The final run had 185 source-tail candidates and 7 off-boundary quiet intervals ≥100 ms totaling 6.28 seconds, with a maximum of 2.18 seconds. The previous run had 194 source-tail candidates and 9 off-boundary intervals totaling 12.88 seconds, with an 8.31-second maximum. Quiet intervals overlapping receiver anomalies remain in the report and are never silently excluded. PCM had no empty frames, non-finite samples, or clipping threshold hits.

Memory did not improve in this comparison. PSS rose by about 0.35 MiB in median and reached 17.28 MiB, then plateaued around 17.27 MiB for the final hours. The service cgroup's roughly 9 MiB charge is not interchangeable with PSS because shared executable/library pages can be charged differently. This run does not establish a leak or a useful memory regression, but it also does not justify claiming a memory reduction.

The measured sender continuity is effectively unchanged from the previous run. The previously tested 10 ms pacing candidate remains reverted because it doubled short sender gaps and concealment in matched trials. No codec, bitrate, FEC, buffer, or pacing change should be promoted based on this comparison. The best supported production choice remains the reverted/original pacing path with the retained diagnostics and evidence safeguards.

Raw evidence, hashes, checkpoint archives, receiver PCM aggregates, sender journal, host sampler, and post-test state are in [`evidence/final-six-hour-20260912`](../evidence/final-six-hour-20260912/). The receiver report intentionally retains transport outages and boundary quiet instead of treating them as clean audio.
