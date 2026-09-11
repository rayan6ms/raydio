# Oracle rerun results — September 11, 2026

The sender completed the six-hour window without a restart. The maintenance
protection worked. This is **not a complete six-hour receiver/PCM test**: a
diagnostic UI dependency stopped that part of the recording after 65 minutes
55 seconds. Sender timing is slightly better; receiver cumulative totals are
encouraging but cannot replace the missing PCM history. A rollback is not
supported by this run alone.

## Comparable sender and resource windows

Candidate binary SHA-256:
`225a2af42cbb9639394db8f0d40d0eb0ae897e81ade62c50e36dfd0ac79a9d91`.
Requested observation: September 11, **11:41:59–17:41:59 UTC**. Testbot played
the same track in General, volume 70, Loop on; production Raydio was inactive.
Process 17958 remained active throughout, with no restart, DAVE failure, or
source overrun in the logs. Maintenance remained masked and Snap refresh held.

Both rows below subtract the first and last in-window minute checkpoints:
360 snapshots spanning **359 minutes** each, rather than pretending the
minute counters cover the exact receiver start/end. Candidate head and tail
outside those checkpoints total 60 seconds; no cumulative counter reset occurred.

| Metric | September 10 baseline | September 11 rerun |
|---|---:|---:|
| Sender gaps ≥40 ms | 228 (38.11/hour) | 220 (36.77/hour) |
| Sender gaps ≥100 ms / ≥1 second | 0 / 0 | 0 / 0 |
| Maximum active send gap at end | 96.011 ms | 81.502 ms |
| Sent frames in checkpoint window | 1,076,449 | 1,076,487 |
| Unavailable/silence frames | 6 | 4 |
| Send failures / source overruns | 0 / 0 | 0 / 0 |
| Skipped-deadline counter* | 282 | 383 |
| Median PSS | 16.646 MiB | 16.548 MiB |
| PSS range | 16.298–16.696 MiB | 15.860–16.587 MiB |
| CPU, percent of one core | 4.004% | 3.931% |
| Host steal time | 0.386% | 0.351% |

The ≥40 ms gap count fell **3.5%**, and the maximum fell **15.1%**. These are
observed differences in separate Internet/VM runs, not proof of causality or
statistical significance. Memory is about 100 KiB lower (0.6%): no meaningful
memory reduction is established. CPU is approximately 1.8% lower relative to
baseline, again a small single-run difference. UDP error, buffer-error and OOM
counters did not increase. Maximum checkpoint separation was 60.009 seconds.

*Skipped deadlines are not a like-for-like metric across the two binaries.
Oto `e3812da` counts missed opportunities during polling/encryption/I/O completion
through `PacerRegistration::complete`, in addition to wakeup lateness; the earlier
coordinator used channel/backlog accounting. The successful-send gap counters
retain their definition, so those are the appropriate direct timing comparison.
The prior report's skipped-deadline rate alone cannot establish a pacing regression.

## What the receiver actually recorded

The immutable report ended at **12:47:55 UTC**, after 3,955.370 seconds of
WebRTC polling and 3,956.272 seconds of PCM. All 382 events, 36 incident windows,
and 67 checkpoint saves survived; the supervised collector had zero write errors
and continued independent host sampling after the browser audit stopped.

During the recorded 65.92 minutes:

- 197,635 received packets; net loss 15, positive loss deltas 59 and corrections −44;
  103 discarded packets, 444 NACKs.
- 7.443 seconds of concealed samples, including 0.547 seconds of silent concealment.
- No clipping, non-finite samples, empty PCM input, or missing PCM reports.
- Two off-boundary quiet intervals ≥100 ms: **235.313 and 229.917 ms**.
  The longest quiet interval was **976.25 ms** at a song boundary. The source-tail
  reference is inherited from the earlier independent source test, not a fresh
  waveform alignment of every loop; overlapping anomalies remain flagged.

The old recorder aborted if its originally captured voice-name DOM node was no
longer connected, using the same error as a real missing receiver. Just before
failure, the visible player disappeared and the browser recorded UI long tasks;
there were no recorded ICE, peer, or track disconnect events. At collection,
the same captured peer, inbound report ID, SSRC, and track were still live and
advancing. This strongly supports a UI replacement/virtualization triggering the
overbroad guard. We did not capture the DOM at failure, so the exact Discord UI
action is unknown. It is not evidence that the bot stopped speaking at 12:47.

The recorder now rebinds a replaced voice row, explicitly marks gaps in speaking
indicator and track-phase coverage, and retains the original PCM graph and
receiver identity/counter baseline. Real peer closure, missing stats, ended track,
identity changes, counter resets and stopped AudioContext still fail the run.
Tests reproduce replacement and temporary UI absence without losing receiver
counter coverage, and verify that true transport failures still fail. The bot
binary was not changed by this diagnostic repair.

## Retrospective receiver counters (different duration)

At **17:59:02 UTC**, the same receiver identity exposed the following cumulative
deltas from the original baseline, over **22,623.456 seconds (6 h 17 m 3 s)**:

| Counter | Prior complete 6 hours | Rerun retrospective 6 h 17 m |
|---|---:|---:|
| Received packets | 1,078,984 | 1,130,577 |
| Net lost packets | 47 | 30 |
| Discarded packets | 567 | 431 |
| NACKs | 2,074 | 1,482 |
| Concealed samples, seconds | 46.066 | 28.478 |
| Silent concealed samples, seconds | 13.509 | 1.211 |

These are retained as a separate snapshot, never substituted into the failed
PCM report. Continuous counter-reset/connection monitoring stopped at 12:47;
the later snapshot matches identity and has plausible monotonic cumulative
totals but cannot prove every intermediate state. It also extends 17 minutes
past the planned end, so exact six-hour packet totals are unavailable. Concealed
sample counts are decoder replacement audio, not a count of audible silence.
The totals favor keeping the candidate for further qualification, but do not
establish interruption-free six-hour playback or an improvement caused by code.

## Final state and next comparison

After preserving the measurements, Testbot and the diagnostic services were
stopped and maintenance timers restored; Snap's hold was removed. Production
Raydio remained stopped. No new endurance run was started during this analysis.

The next receiver qualification should use the fixed UI observer and supervised
collector. If successful-send gap rates later regress in repeated comparable
conditions, isolate the pacer change with alternating baseline/candidate trials
before choosing a rollback. This rerun does not reproduce the interrupted run's
≥100 ms gaps or elevated ≥40 ms gap rate.

Evidence: [`transport-rerun-20260911`](../evidence/transport-improvements-20260911/transport-rerun-20260911/).
The failed receiver report, retrospective snapshot, full sender summary, raw
service/host evidence, and collection hashes are preserved separately.
