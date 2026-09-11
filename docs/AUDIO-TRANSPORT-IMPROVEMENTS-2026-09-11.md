# Audio transport improvements — 2026-09-11

Status: dependency changes implemented and tested; Raydio release integration and
fresh receiver validation in progress. A reduction in live Discord packet loss or
concealed-sample duration has **not** been established by the experiments below.

## Corrected six-hour baseline

The September 10 observation retained all 21,600 seconds of PCM and receiver
polling. It recorded 1,078,984 received packets, net loss 47, positive loss deltas
228, negative corrections −181, 567 discarded packets, and 2,074 NACKs.
Concealment was 46.0663 seconds, including 13.5093 seconds of silent concealment.
Concealment counts include synthetic replacement samples; they do not mean that
all of that duration was audible silence. Negative loss deltas do not prove a
corresponding number of successful retransmissions.

The original report missed seven off-boundary quiet intervals: 320.125, 281.208,
231.313, 516.729, 487.500, 712.021, and 560.167 ms. The two long off-boundary
intervals were 8,310.250 and 1,461.167 ms. The corrected classification contains
194 source-tail candidates, nine boundary intervals with overlapping anomalies,
and 15 off-boundary intervals (including those shorter than 100 ms).
The independent source tail is 938.458 ms. Boundary coincidence alone does not
prove source-only silence; all quiet intervals remain in the totals and report.

The sender had 228 gaps of at least 40 ms, a maximum qualifying gap of 96.011 ms,
282 skipped deadlines, six unavailable/silence frames, no local send failures,
and no source overruns. Its 1,076,449-frame delta covers **359 interior minutes**,
not the complete receiver window. Minute brackets around both long outages
continued advancing by 3,000 frames, with unchanged error/gap counters. That
rules out a sender stall of those durations, but cannot identify the failing
hop between Oracle, Discord, the listener's network, and WebRTC.

Bot PSS was 16,689–17,097 KiB (median 17,045 KiB), CPU about 4.004% of one core,
and host steal about 0.386%. UDP errors and OOM counters did not increase.
All 2,048 event sequences survived the 361 checkpoint saves. Four detailed
incident windows were evicted from the browser's 256-window ring; detailed
incident-window coverage was therefore incomplete. Sender and kernel logs are
now also preserved as tracked `.txt` files; their original `.log` paths were
excluded by ignore rules.

## Direct sender timer

Oto previously scheduled each packet through a coordinator task and a capacity-one
channel, then woke the audio task. The audio task now awaits its own absolute
deadline on the caller's Tokio runtime. This removes four coordinator tasks,
registration/control queues and their per-sender storage. It retains one frame
per opportunity, readiness-driven idle behavior, cancellation, DAVE barriers,
and recovery without a catch-up burst. No Opus frame is dropped to manufacture
better timing. Skipped deadlines include delays during frame work, without
double-counting delays already observed at wakeup.

The controlled harness uses actual Oto gateway, encryption, pacing and loopback
UDP paths. It is **not the full Raydio bot**. Both A/B binaries use the same
harness lockfile and Rust toolchain; they compare sender revision `e1bdc068`
with the direct-timer candidate. Tests use two runtime workers. The initial
benchmark accidentally run in the unrelated old `oto` checkout is excluded.

| Oracle, one sender, 120 seconds each | Baseline 1 | Candidate 1 | Baseline 2 | Candidate 2 |
|---|---:|---:|---:|---:|
| p99.9 absolute packet-interval error | 4.902 ms | 3.705 ms | 9.647 ms | 8.881 ms |
| Maximum observed packet interval | 31.593 ms | 27.362 ms | 32.638 ms | 33.103 ms |
| CPU, percent of one core | 0.550% | 0.533% | 0.575% | 0.558% |
| Active PSS | 7,061 KiB | 7,005 KiB | 6,964 KiB | 7,041 KiB |
| Harness active tasks | 10 | 6 | 10 | 6 |

All four timing windows delivered every counted packet to the local UDP peer and
had zero intervals ≥40 ms. The tail-error reductions were 24.4% and 7.9%, but the
maximum gap improved in only one pair. The memory result varies within tens of
KiB and is not evidence of a meaningful reduction in full-bot memory. These short
windows cannot establish a lower six-hour rate of rare ≥40 ms sender gaps.

Baseline 2 subsequently failed the **allocation** assertion: its separate
one-second busy-yield region observed two allocations (128 bytes) and delayed
frame recovery. The preceding 120-second timing data are retained, with the
failed test marked explicitly. Future allocation sampling sleeps rather than
busy-yielding, and startup polling also sleeps. This avoids turning the harness
into a CPU load generator on Oracle's fractional-core VM. No assertion was
removed or weakened.

Local 100-sender timing improved from 1.829 to 1.246 ms p99.9 interval error
(31.9%), and the maximum interval fell from 22.152 to 21.426 ms. CPU increased
from 7.63% to 8.33% of one core in that one pair. The single-sender local trials
showed no clear timing improvement. These results support a simpler scheduler
with a modest tail-latency benefit, not a claim that host scheduling stalls have
been eliminated.

## Opus loss resilience without forced speech encoding

`benchmarks/opus_loss_probe.c` independently decodes the saved source packets,
applies Mantle's exact integer conversion and nonlinear volume-70 multiplier,
then re-encodes with the deployment's pinned static libopus. It compares clean,
PLC, and next-packet-FEC decoding with identical deterministic loss masks.
Waveform error is measured against each configuration's loss-free decoded
output; clean SNR is measured against the input with codec lookahead aligned.
This is a signal-error metric, **not a perceptual listening score**.

| Loss hint, FEC disabled | Clean SNR | Summed loss-induced squared error, three masks |
|---|---:|---:|
| 0% | 15.9008 dB | 3,538.67 |
| 1% | 15.8850 dB | 3,308.24 |
| 3% | 15.8691 dB | 3,224.01 |
| **5% selected** | **15.8413 dB** | **3,158.29** |
| 10% | 15.8197 dB | 3,155.52 |

The selected setting reduces loss-induced waveform error by **10.75%** across
three independently shifted isolated-loss masks. The clean-SNR change is
−0.0595 dB. Encoding CPU medians were 2.297 versus 2.352 seconds for 213.06 seconds
of music, approximately +2.4% encoder CPU, or +0.026 percentage points of one core
averaged over playback. This is one track, so broad perceptual transparency is
not established. The setting alters CELT prediction/intra refresh behavior, while
retaining complexity 10, bitrate policy, stereo and 20 ms geometry.

Forcing FEC (`INBAND_FEC=1`, 10% hint) recovered 101/106 isolated missing frames
in this source, but changed every packet from CELT music mode to hybrid mode,
roughly tripled encode CPU, and reduced clean SNR to 7.35 dB. It was rejected.
Music-preserving FEC mode 2 provided no recoverable frame for those loss masks.
The WebRTC `fecPacketsReceived` counter alone is not a reliable test of Opus
in-band recovery, so the experiment inspected actual LBRR presence and decoded
recovery output.

Mantle now provides validated loss-hint configuration and applies 5% in its
network playback transcoders. The low-level encoder default stays at 0%. Reset
preserves the configured hint and does not turn on FEC. Encoded passthrough is
unchanged; the hint only helps audio that Mantle re-encodes (including volume 70).
It cannot reduce raw network packet loss or eliminate PLC during long outages.

## Diagnostics changes

- Oto offers an opt-in 1–4,096-record single-producer ring containing only actual
  RTP header fields, successful-send monotonic time, source/connection generation,
  silence flag and record index. Full rings drop diagnostic records, never audio,
  and count every dropped record. No per-packet allocation, formatting or I/O.
- Crust can drain 1,024-record rings through existing snapshots, with explicit
  overflow and wall-clock anchor. Raydio enables this only with process environment
  `RAYDIO_SEND_TRACE=1`. Leave it off for normal deployment and acceptance runs
  until logging overhead is measured. Trace tests cover packet sequence/timestamp
  wrap, silence drain, startup, and consumer disposal. A diagnostic command queued
  at the initial Speaking barrier must preserve the staged first audio frame.
- `summarize_send_trace.py` validates batches, record loss, RTP wrap and transport
  boundaries. It never calls successful local UDP submission delivered audio.
  A long interval involving a pause, source change, or silence requires lifecycle
  correlation; it is not automatically a playback defect.
- Receiver windows have stable IDs and revisioned disk archival, so a checkpoint
  during an open incident does not lose its later post-incident samples. The shared
  archive limit is 64 MiB. The summarizer merges revisions and explicitly reports
  missing or incomplete windows. Natural source boundaries remain separate from
  intervals with overlapping receiver anomalies.

The complete encrypted Oto path measured about 1,500 packets/30 seconds with
tracing both off and on: every counted packet arrived, zero allocations or
reallocations in the measured region, and no overflow. This validates producer
overhead; it does not yet measure Crust's batch log writer under Oracle load.

## Verification and remaining claim limits

Passed: Oto 109 regression tests; Mantle Opus 4, audio 34 and playback 7 targeted
tests; Crust media adapter 30 and voice adapter 16 tests; pinned-toolchain Clippy
for changed dependency crates; receiver archival/classification and trace-parser
regressions; simulated six-hour browser diagnostic test. Release and live results
will be appended after completion.

Do not increase buffers, reconnect the bot blindly, lower music quality, or add
duplicate UDP packets merely to improve a counter. Current evidence shows no
sender socket-buffer overflow, no local send errors, and no basis for blaming a
particular external network hop. A fresh matched receiver observation is required
before claiming reduced live loss/concealment duration. A longer observation is
required to compare the rare sender-gap rate to the six-hour baseline.

Evidence: [`evidence/transport-improvements-20260911`](../evidence/transport-improvements-20260911),
including rejected/failed experiments and exact source/libopus hashes.

## Fresh full-bot receiver run

On 2026-09-11, the transport-improvements candidate (SHA-256
`225a2af42cbb9639394db8f0d40d0eb0ae897e81ade62c50e36dfd0ac79a9d91`) ran as the
isolated Testbot on Oracle while a signed-in Discord receiver stayed in General.
The command was submitted through Discord's Send Message control and Loop was
enabled. The five-minute receiver observation completed with 300.000 seconds of
receiver time and 300.011 seconds of PCM coverage. It had zero connection,
track, clipping, non-finite, or empty-frame errors and retained all 32 events and
five diagnostic windows.

The receiver reported 14,912 packets, 50 positive lost packets, one discarded
packet, 14 NACKs, 2,419.8 ms of concealment, and 1,697.9 ms of silent
concealment. The loss occurred in a one-second window at about 202.3 seconds;
the following window recovered. PCM recorded one 1,693.0 ms off-boundary quiet
interval overlapping that receiver incident. Sender checkpoints covering the
interior four minutes show five additional >=40 ms gaps, no >=100 ms gap, no
send failures, no unavailable frames, and no source overruns. Oracle UDP error
and receive-buffer counters remained zero. PSS was 15.52–15.79 MiB (median
15.74 MiB), and CPU was 3.99% of one core.

The sender counters did not change during the receiver outage, so these data do
not support a sender-side cause or a code fix that would eliminate this event.
They do establish a reproducible diagnostic classification: the interval is
not a natural loop boundary and must remain an external receiver-path loss
until a matched network experiment isolates the hop. The immutable report is
`target/transport-improvements-20260911/full-candidate-receiver/receiver-final-56063444d01779a9c42668c1ed436f79b188cc59dab5a5f1afe75b7cd6167864.json`.
