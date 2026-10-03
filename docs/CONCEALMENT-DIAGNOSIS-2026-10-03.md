# Concealment diagnosis and isolated-worker qualification

## Decision

No reliable reduction below the October 2 full-stage baseline of 79.6875 ms
per five minutes has been demonstrated. Keep the progressive production build
`80f4ec6` running on Oracle. The subsequent cleanup retired the worker option
from Raydio's active build and CI; upstream opt-in library code and historical
evidence remain preserved. See [the follow-up](CONCEALMENT-FOLLOWUP-2026-10-03.md).

The worker protects against a blocked ordinary runtime in the controlled UDP
benchmark. Live measurements do not establish a consistent receiver benefit.
Concealment still occurs with healthy sender timing. Some larger bursts also
overlap Oracle CPU-steal spikes. These are distinct diagnostic findings, not a
proven single cause or a reason to alter codec quality speculatively.

## Protocol and measurement

All live windows used Raydio alone on the existing Always Free Oracle micro
instance, `test` → General, Akcent “Stay With Me” (`4moWSMi1L_4`), volume 70,
and Loop ON. Testbot stayed stopped. Commands were submitted through the
controlled Discord browser using paste, the Raydio command-menu option, and
the Send button; Loop was clicked and verified before each recording.

The four comparison windows had packet tracing disabled. No builds, controls,
source probes, ping probes, packet interception, or exports occurred during
their observation windows. Host collectors sampled once per second; expensive
memory sampling remained bounded to once per ten seconds. Browser writes were
bounded checkpoints, with final saves after completion. The later trace run
was a separate diagnostic experiment, excluded from the build comparison.

Journal collection was filtered by both service and PID. This prevents records
from the outgoing process during restarts from contaminating a new run.
All receiver windows completed with complete poll and PCM coverage, no
connection interruption, no clipping, no non-finite samples, and zero silent
concealment. Quiet intervals remain in the evidence; the four five-minute
windows had only source-tail candidates among intervals ≥100 ms. The trace
window ended before a loop boundary and had no quiet interval ≥100 ms.

The current finite source was checked read-only after the default recheck:
4,167,934 bytes, SHA-256
`a31c27999d21b6402368699057c277597e906ca88e4ab68ab3cf6322df685097`.
It matches the earlier decoded source reference: 265.1875 ms of head quiet
and 1,931.7917 ms of tail quiet. Temporal boundary agreement remains a candidate
classification, not proof that every boundary is free from transmission delay.

## Live comparison

Times are UTC on October 3 (São Paulo: subtract three hours, October 2).
Concealment is a receiver counter, not measured missing bot PCM at the sender.

| Window | Start UTC | Duration | Concealment | Discards | Net loss | NACKs | Sender gaps ≥40 ms* | Median PSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Progressive default baseline | 00:03:35.646 | 300 s | 185.000 ms | 0 | 0 | 16 | 6 | 16.732 MiB |
| Worker candidate | 00:24:27.914 | 300 s | 1,120.271 ms | 27 | 0 | 57 | 5 | unavailable |
| Same worker, uninterrupted repeat | 00:30:58.402 | 300 s | 294.292 ms | 5 | 0 | 10 | 6 | 16.628 MiB |
| Restored progressive default | 00:39:19.402 | 300 s | 397.833 ms | 7 | 0 | 22 | 0 | 15.681 MiB |

*Sender counters cover only the interior checkpoint interval, approximately
four minutes. Exact uncovered head/tail and checkpoint times are in each
summary. They must not be represented as full five-minute packet traces.
All interior windows had zero source overruns, unavailable frames, send failures,
silence frames, and gaps ≥100 ms. The final default window had 12,000 frames
and zero skipped deadlines in that interior interval.

The worker repeat has 26.03% less concealment than the following default window,
but 59.08% more than the earlier default baseline. Its first window was worse
again. Both default and worker outcomes vary substantially; selection of only
the best window would be misleading. The earlier 79.6875 ms full-stage result
is also a different time/network scheduling sample, not a deterministic target
that one short recording can prove a build achieves consistently.

Median CPU was not measured: total sampled CPU time gives 3.817% of one core
for the default baseline, 4.065% for the worker repeat, and 3.797% for the default
recheck. Differences in PSS and CPU are small and not a proven optimization.

### Collector failure retained

The first worker host sampler failed because its output parent directory had
not been created. Its receiver and sender counters remain usable, but CPU,
memory and host-steal attribution for that window are unavailable. The empty
resource file and warnings are deliberately preserved. No host measurements
were reconstructed from a later run.

`benchmarks/endurance_host.py` now creates the parent directory after validating
the owned process identity, while retaining exclusive creation of the output
file. The repeat and subsequent runs verified both an active sampler and actual
advancing samples before receiver recording. Per-vCPU tick counters were added
without another `/proc/stat` read, allowing future attribution of steal spikes
to individual CPUs. This updated sampler is installed on Oracle.

## Host scheduling burst

In the worker repeat, receiver polls at +224.372 and +225.373 seconds reported
112.271 and 93.646 ms of concealment. The sender's last ≥40 ms gap timestamp
was +224.489 seconds. The host sample ending at +224.786 seconds reported
30.093% steal across the two virtual CPUs. This is strong timing agreement with
a host scheduling disruption; it is not a packet-delivery measurement.

The default recheck also had steal spikes late in its run: 20.283% in the sample
ending at +279.193 seconds (CPU0 22.43%, CPU1 17.31%), and 15.196% at +283.202.
The receiver reported 101.063 ms concealment near +279.440 seconds. These occur
after the last interior sender checkpoint; the zero interior gap count cannot
rule out a sender gap in that unobserved tail.

Ordinary-runtime isolation cannot execute while the hypervisor withholds CPU.
Pinning a thread to one CPU is not justified by these samples: both CPUs were
affected in the default recheck. No real-time scheduling, CPU affinity, or
codec changes were introduced without evidence of benefit.

## Recurring small receiver events

Across both builds many receiver events fall near UTC seconds 12, 27, 42 and
57. In the default recheck the early events were separated by approximately
15.02 seconds, with some multiples when no concealment was reported. That
phase also appears across process restarts and the same-worker repeat. It is
not evidence that the song's ending was being counted as this concealment.

To distinguish sender timing from later effects, a separate 180-second
recording enabled the existing bounded Oto timing batches, with no packet
interposer or payload capture. It reported 9,000 received packets, zero net
loss (+1/−1 temporary correction), one discard, 74.8958 ms concealment,
zero silent concealment, and uninterrupted full receiver/PCM coverage.
The normalized concealment rate is 24.9653 ms/minute; its shorter duration and
instrumentation mean it is not a five-minute candidate win.

The trace included 9,000 aligned submissions in the receiver window, with no
≥40 ms sender gap. The complete collected stream had no missing/dropped
records, sequence jumps, timestamp jumps, conflicting records, or clock
reversals. Four receiver-concealment polls were examined from two seconds
before through one second after each poll, including the preceding packet:

| Receiver poll UTC | Concealment | Maximum nearby sender gap |
| --- | ---: | ---: |
| 00:51:57.9486 | 13.438 ms | 25.371 ms |
| 00:52:12.9727 | 24.354 ms | 21.555 ms |
| 00:52:58.0374 | 16.542 ms | 21.984 ms |
| 00:53:42.1008 | 20.563 ms | 24.056 ms |

Source polls in those windows were ≤45 µs; DAVE round trips ≤317 µs.
Detailed maxima, including wake lateness and UDP work, are preserved in
`trace/periodic-incidents.json`. UDP submission is not delivery confirmation.
Small sender jitter remains possible, but these incidents do not show a
corresponding long sender stall, exhausted source, or slow encryption operation.
The remaining hypotheses include Discord forwarding, route delay, and receiver
jitter-buffer/playout behavior. One receiver on one connection cannot identify
the responsible hop. No claim of a Starlink outage or a specific defective
network component is warranted.

Separate post-recording 120-packet probes found zero LAN/WAN packet loss:
LAN min/avg/max 0.321/0.474/0.865 ms; Cloudflare WAN
15.327/24.357/78.259 ms. They were not simultaneous with the recorded incidents
and use a different destination/protocol. They cannot establish Discord's route
quality or rule out an earlier interruption.

## Worker mechanism and build verification

Raydio initially did not expose the feature in its manifest. For this experiment,
the evaluated feature forwarded `experimental-audio-worker` to `crust-server`,
which forwarded it to both adapters and Oto. `--version` reported its compiled state. The deployed
candidate package and live minute logs confirmed `isolated_audio_worker=true`.
The restored production build uses the default path.

The worker is one shared audio executor plus a bounded eight-frame Opus buffer.
It preserves encoding and volume; buffered controls require lifecycle checks.
Two sequential runs of the existing integrated UDP benchmark at the exact
production Oto pin injected a 100 ms block in the ordinary runtime:

| Mode | Packets | Gap crossing injected stall | Maximum gap | Send failures |
| --- | ---: | ---: | ---: | ---: |
| Default | 160 | 120.016 ms | 120.016 ms | 0 |
| Worker | 160 | 20.797 ms | 21.453 ms | 0 |

The stall-crossing gap fell 82.67%; the maximum gap fell 82.12%. This validates
runtime isolation for that artificial failure, not a live end-to-end guarantee.
The benchmark and tests used clean worktrees at the production pins, preserving
unrelated dirty changes in the old Oto checkout.

The worker-enabled Raydio suite passed 58 tests and Clippy. Both adapter suites
passed 50 non-ignored tests, including pause/drain, seek/replacement, shutdown,
cancelled waiters and terminal failures. At the time, CI checked both feature
modes. The follow-up retired that candidate wiring; release builds use the
default mode.

## Operational repairs and final state

The local public IP changed during this work. New SSH connections failed
because the current address was absent from Oracle's ingress allowlist. One
exact `/32` SSH-only rule was added, preserving existing ingress rules. A stale
server-side SSH tunnel held ports 18080/8282 after its local connection died.
Only that stale tunnel session was terminated; the owned tunnel service then
reconnected. The first candidate `/play` timed out during this disruption and
was retried before recording. This media-resolution failure is separate from
the already-buffered audio measurements and from the earlier receiver outage.

After diagnosis the tracing override was removed, the default production build
was restarted, and playback/Loop were restored. All temporary recording
collectors were stopped. No paid resource, additional Oracle instance, or
production codec-quality change was introduced.

Residual concealment is unresolved. Further code changes need a reproduced
sender defect or a delivery mechanism with measured benefit; a receiver-path
remedy needs narrower network/receiver evidence. These runs do not justify
promoting the worker or claiming a guaranteed six-hour artifact-free session.

Evidence: [concealment-diagnosis-20261003](concealment-diagnosis-20261003/).
