# Mid-song stutter investigation

The user reported repeated local audio pauses accompanied by the speaking ring
turning off. The earlier five-second receiver windows did not exclude these
short interruptions.

The baseline finite-source path opens a new 256 KiB HTTP range on demand. The
Crust/Oto bridge stages one 20 ms frame, and Oto sends silence when a frame is
unavailable. Five consecutive unavailable frames end the speaking indication.

`examples/source_timing.rs` measures the real Mantle adapter at volume 70 with
one paced pull every 20 ms, without Discord transport. No build overlapped
either three-minute source measurement:

| Source measurement | Original | 16-frame read ahead |
| --- | ---: | ---: |
| Reads taking at least 20 ms | 11 | 0 |
| Slowest read | 129.809 ms | 0.618 ms |
| Median read | 0.538 ms | 0.039 ms |
| p99 read | 0.781 ms | 0.098 ms |
| Delivered frames in 180 seconds | 8,952 | 9,000 |

Raw observations: [before](source-stalls-before.json) and
[buffered](source-stalls-buffer16.json). The before stalls recur about every
16 seconds and take 90–130 ms. This establishes a source-starvation mechanism;
it does not by itself measure Discord reception or subjective sound quality.

The final public dependency `f7d6c69` was remeasured after the filter-command
fix: [180 seconds, 9,000 frames](source-stalls-final.json), zero reads exceeding
20 ms, median 0.047 ms, p99 0.104 ms, maximum 0.592 ms. No build overlapped it.

The prototype keeps at most 16 encoded frames in the Mantle adapter and one
owned read in flight on the existing blocking pool. Oto still owns pacing.
Prefetched EOF/errors follow the buffered audio; delivered position advances
only when a frame is consumed. Pause retains buffered frames, seek and track
replacement invalidate them, and stop frees the allocation. Filter/volume
changes affect newly produced frames, so an existing buffer can delay their
audible effect by up to 320 ms, in addition to receiver buffering. The live
source polling path is unchanged.

The first [100 ms receiver baseline](audio-stutter-baseline.json) captured
5 concealment events and 7,390 concealed samples over 150 seconds, with zero
reported packet loss. It overlapped a one-job compilation and is diagnostic
evidence, not a matched unloaded before/after performance comparison.

The measurements below distinguish the source fix from reception quality.

The unloaded [matching baseline](audio-stutter-matched-before.json) reproduced
10 speaking-indicator dropouts in 150 seconds and 8 near-silent PCM runs,
42.7–85.3 ms each. Packet loss and concealed samples were both zero: the sender
was delivering encoded silence while starved, which ordinary transport loss
and concealment counters cannot identify. The voice-row speaking class was
observed through DOM mutations, and PCM analysis retained aggregate levels and
silence durations only. No audio was recorded.

## Receiver and sender verification, September 6

All captures below are 150-second mid-song windows with loop off, volume 70,
one listener, and no concurrent build or controls. The corrected final
filter-command handling described below still requires a package capture.

| Measurement | Original | Buffer, fresh receiver | Buffer, traced sender |
| --- | ---: | ---: | ---: |
| Speaking off/on interruptions | 10 | 0 | 2 |
| Silent PCM blocks (42.7 ms each) | 10 | 0 | 0 |
| Longest silent PCM run | 85.3 ms | 0 | 0 |
| Net lost packets | 0 | 3 | 5 |
| Concealed samples | 0 | 10,376 | 31,765 |
| Clipped/nonfinite samples | 0 | 0 | 0 |

The original sends encoded silence during starvation, so its zero loss and
concealment counters do not imply better audio. The new captures eliminate that
periodic source-silence pattern. They do **not** establish artifact-free or
lossless reception. Raw files: [fresh](audio-stutter-buffer16-fresh.json),
[traced](audio-stutter-buffer16-traced.json).

The earlier [failed buffered capture](audio-stutter-buffer16-packet-loss.json)
is retained: 221 lost packets, 260,547 concealed samples, and a 1.323-second
silent run. It is not a passing result. After restarting the receiver, loss was
much smaller, but that is not proof that a restart fixes the transmission path.

A Linux diagnostic interposer recorded outbound RTP counters and timing during
the traced run; no packet bodies, audio, addresses, or credentials were recorded.
[Sender results](udp-send-buffer16.json): 7,503 successful sends in 150.040 s,
zero sequence or timestamp gaps, zero intervals over 25 ms, p99 interval
20.847 ms, maximum 21.041 ms. Median syscall duration was 15.0 microseconds.
Successful local sends do not prove delivery to Discord. Combined with receiver
loss, these measurements locate the remaining problem after the bot's send
call; they cannot distinguish the uplink, Discord SFU, downlink, or receiver.
The browser used UDP, with a sampled 21 ms ICE round-trip time. Host UDP error
counters were zero. No production packet logging was added.

`benchmarks/udp_send_trace.c` is an optional diagnostic only. Build it with
`cc -O2 -Wall -Wextra -Werror -shared -fPIC benchmarks/udp_send_trace.c -ldl -o target/udp-trace.so`,
then pass `--udp-trace-library target/udp-trace.so --udp-trace-output target/udp.csv`
to `benchmarks/start_rust.py`. The output file must be new; recording is capped
at 60,000 packets. Columns are monotonic completion nanoseconds, call duration
nanoseconds, fd, RTP sequence, RTP timestamp, requested bytes, sent bytes.
Tracing changes the process and is unsuitable for memory comparisons.

## Controls and resource cost

The [12-action control test](stutter-controls-buffer16-traced.json) completed
all alternating Pause/Resume operations. The earlier attempt crossed natural
track end and timed out, so it is excluded from latency comparisons. The
prototype traced run is functional evidence; no control-latency speedup is
claimed from these separate network runs.

A deterministic regression subsequently demonstrated that a filter command
could hold the actor while a source read was pending, preventing buffered
frames from reaching Oto. Filter updates now wait in a bounded queue while
buffered audio remains available. They retain order, reply only after applying,
and drain before source mutation/stop. Queue overflow returns an explicit
overload error. Both the reproduced blocking case and overload/order/cleanup
are tested. All 18 adapter tests and Clippy pass (two pre-existing opt-in
benchmarks are outside this test run).

The prototype's three alternating authenticated-idle starts measured median
PSS 11,692 → 12,154 KiB (+462 KiB, +3.95%). Seven playback windows measured
15,611 → 15,804 KiB (+193 KiB, +1.24%), with four threads in both versions.
CPU medians were 2.897% → 2.947% of one core. This is a reliability fix with
a small measured memory cost, **not** a memory reduction. Idle allocates no
audio buffer; one mapping comparison attributed most of that idle difference
to resident executable/readonly pages. These prototype measurements do not
stand in for the final portable artifact.
