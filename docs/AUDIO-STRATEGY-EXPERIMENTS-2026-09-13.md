# Audio strategy experiments — 2026-09-13

## Correction — 2026-09-14

**The report below overstated the testing and its conclusions. It is retained
as a historical record and superseded by this correction.** Neither adaptive
read-ahead nor an independent sender queue was implemented or compared against
baseline. No before/after improvement for those strategies has been established.

The deployed Oto pin is `e205f9a3f44be36fab2fa3cd48ef113cbb0f4d1f`, whose
audio executor owns its timer directly. The September 13 benchmarks instead ran
in the older `/home/rayan/Documents/Projects/oto` checkout (HEAD
`8d7a0cbd4e74fa796e0e99cd8634901ce1917bd4`, with dirty gateway/pacer files).
That checkout still uses coordinator/deadline channels. Its packet, allocation
and timing figures below cannot establish the deployed bot's performance or
justify rejecting an independent sender queue. The two benchmark commands also
ran concurrently, so their timing/CPU data are not isolated measurements.

The four allocation tests did pass at deployed Mantle pin
`5b7caf0b6db492e8a56abac1bd4d36da76d5c8c5`. They count Rust allocator calls
in the instrumented thread after construction, not native allocations or total
bot memory. This supports retaining the reusable frame slots; it does not prove
that the full Crust/Mantle adapter has zero allocations. Its adapter regressions
were inspected, not rerun during this investigation.

Corrected recommendations:

- Adaptive read-ahead remains untested. Retain the 16-frame default until a
  controlled source-stall experiment establishes a benefit, testing finite and
  live sources separately. Extra read-ahead does not necessarily add steady
  playback latency; control impact depends on handling of prefetched frames.
- An independently scheduled sender queue remains worth testing. Compare it
  against the deployed direct timer under normal operation, upstream executor
  stalls and sender/whole-host stalls. Validate frame order, source/connection
  generations, DAVE transitions, pause/stop and shutdown before promotion.
- Do not add a redundant frame pool. Profile any remaining task/future
  allocations in the full adapter before proposing an alternative.
- Direct Opus passthrough already exists. Install local Fedora `gcc-c++` to
  unblock the pinned media regression build, then test real packet identity,
  safe processing transitions and CPU with identical sources. The low-level
  test alone does not establish these results. Volume 70 requires processing;
  switching to 100 would not be a matched loudness comparison. Passthrough
  cannot apply the re-encoder's 5% loss hint. No compiler is needed on Oracle
  to run the prebuilt bot.
- Seek ghosting remains excluded as requested.

Production was unchanged. No new strategy has earned production promotion from
these experiments. Independent sender scheduling cannot fix downstream packet
loss or whole-VM descheduling.

## Superseded report

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
