# Audio strategy experiments — 2026-09-13

This note records the requested tests of ideas used by LavaPlayer/Lavalink/Koe.
The deployed Oracle release was left unchanged while the experiments ran.

## Results

### Adaptive read-ahead

The current Crust/Mantle adapter keeps a bounded queue of 16 encoded frames
(320 ms at the required 20 ms frame size), starts at most one blocking source
read at a time, and never drops a frame when the queue is full. It deliberately
does not apply this read-ahead to live sessions. The adapter's regression tests
cover bounded fill, ordering, pause/resume, blocked reads, cancellation, errors,
and EOF after the buffered tail.

An adaptive increase would only enlarge the same source-read queue and would
increase retained media and seek/control distance. It cannot protect the sender
when the Tokio worker or host is descheduled. No reproducible source underrun
was identified in the current evidence, so this candidate was rejected without
changing production behavior.

### Bounded outbound sender queue

Oto already uses bounded capacity-one frame/deadline channels, readiness-driven
polling, absolute deadlines, and one frame per opportunity. Its delayed-executor
test verifies that a late wake produces one signal and never a catch-up burst;
the full suite also verifies that a full sender slot cannot block an unrelated
sender. A second queue on the same Tokio executor would not run during an
executor stall and could add latency or stale-frame lifecycle cases.

Release benchmark (`p07_complete_non_dave_path_benchmark`, pinned Rust 1.97.1,
250 senders, 3 s measurement) delivered all 37,500 packets, reported zero
audio-path allocations, 24.65% of one logical core, 2,416,771 ns maximum sender
lateness, and p99 interval error 1,560,682 ns. The complete paced DAVE benchmark
also delivered all 151 packets with zero allocations and 2,035,670 ns maximum
sender lateness. No queue change is justified by these measurements.

### Non-allocating frame pool

Mantle's `mantle-audio` allocation tests passed for passthrough + SPSC delivery,
PCM Opus encode + SPSC delivery, decode/filter/encode, and streaming PCM assembly.
Each reports zero allocations after construction. The existing reusable frame
slots and ring therefore already provide the intended pool behavior; adding a
second pool would be redundant.

### Direct Opus passthrough

The low-level passthrough test passed and confirms zero allocations after warm-up.
Mantle's media tests define exact packet identity and safe return to passthrough
after seek/filter transitions. Passthrough remains automatically selected only
for compatible 20 ms Opus with no effective PCM filters. Server volume 70 still
requires decode/re-encode, so passthrough must not be compared at a different
loudness setting. The exact `mantle-media` YouTube regression test could not be
built in this environment because the pinned workspace's `mantle-xaac` build
requires a C++ compiler and this host has only `gcc`; no test assertion was
weakened and no production code was changed.

## Decision

Keep the current implementations. They already satisfy the boundedness and
steady-state allocation goals demonstrated by the available tests. A future
adaptive read-ahead or native sender-thread queue needs a controlled scheduler
stall benchmark first; it should not be introduced solely to improve packet
counters. Re-run the full Mantle media regression suite on a build host with a
C++ compiler before release changes involving source-format selection.

