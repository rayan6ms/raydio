# Oracle continuous receiver qualification

The current setup is **not yet qualified for six hours**. Short clean receiver
windows in `ORACLE-RELIABILITY.md` do not establish continuous reliability.

## First attempt: terminal failure

On 2026-09-06, Testbot ran release v0.2.1 on the existing Always Free Micro VM,
with two Tokio workers and volume 70, looping `dQw4w9WgXcQ` in test / General.
The controlled browser was a muted listener. Observation started at
18:04:39.529 UTC, after the track had already been playing for about three
minutes. The bot stopped voice at 18:05:00.020 UTC:

```text
audio sender stopped after a terminal failure
failure=Some(FrameSourceContract) source_overruns=1 send_failures=0 skipped_deadlines=3
```

The browser peer remained connected, Discord displayed a voice-closed message,
and the bot process stayed alive. This was a terminal sender failure. There
were no new SSH sessions, builds, packet traces, or scheduler probes during
the measured interval. See `endurance-terminal-source-failure.json`.

## Candidate repair and evidence

Crust 173fe86 replaces its Tokio mpsc `try_recv` call with `poll_recv`. Tokio
1.53.1 `try_recv` can park when a producer is publishing; `poll_recv` yields and
registers/rechecks the latest waker. The bridge keeps its one-frame capacity
and removes a redundant AtomicWaker. Its 13 tests cover lifecycle/error ordering,
cancellation, cooperative budget exhaustion, and 4,096 concurrent ordered frames.
The cooperative-yield regression fails on the former implementation. This does
not reproduce the internal Tokio publication parking race deterministically.

Oto 3b770a9 retains the last overrun's elapsed and Linux thread CPU durations
in its durable snapshot and Crust's terminal warning. It adds no timing calls
or per-frame logging and retains the 2 ms CPU kill gate. All 79 Oto tests and
both crates' Clippy checks pass. The DAVE test retained 500 frames/packets and
zero allocations in 10 seconds. The bridge benchmark retained the same
allocation count and thread count; memory and CPU variations do not establish
an improvement. Raw results are in `bridge-{before,after}-poll-recv.json` and
`oto-overrun-telemetry-dave.json`.

The possible parking path is a proven contract problem. Its causal role in
the Oracle CPU-time rejection remains unproved until live diagnosis.

## Measurement rules

- Use the existing single free VM and the real Discord receiver. No second
  instance, paid plan, audio-bitrate reduction, or overlapping active bot stream.
- Start the exact candidate binary and a low-priority minute resource sampler
  before measurement. Avoid new SSH sessions, deployments, builds, packet
  traces, or kernel probes during measured playback. Normal host maintenance
  stays enabled; the sampler's own cost remains part of the test conditions.
- `benchmarks/browser_endurance.js` gathers one-second WebRTC counters and
  audio-thread PCM aggregates without recording or duplicating audible audio.
  Prime the analysis graph before measurement: the earlier meter's initial
  20 ms quiet buffer was reproduced and removed from measured startup.
- Retain positive loss deltas even if late packets later cancel net loss.
  Record concealment, silent samples, near-full-scale/nonfinite samples,
  speaking transitions, peer changes, and missing measurement intervals.
- Retain track endings/restarts and their quiet intervals for review. A track
  boundary is not a blanket exemption from the continuity requirement.
- Capture browser checkpoints locally. A replaced or lost receiver invalidates
  continuous receiver coverage; do not combine shorter windows into a six-hour
  pass. Successful measurement completion is not automatically a quality pass.

## Second attempt and targeted diagnosis

The `poll_recv` candidate d307ca7 passed all 49 Raydio tests and native CI
34051708409 on x86-64 and ARM64, but failed live. Its local-built Oracle binary
SHA256 was `82df0a853837e725b549c2b722c056efc7529b909fe95ef32314097f4500526c`.
At 18:36:01.858875 UTC it terminated with 2,065 us elapsed, 2,036 us thread CPU,
zero send failures and 16 skipped deadlines. The receiver had 235 seconds of
coverage, zero net/positive packet loss, and no clipping, but a 340.5 ms
concealment burst and about 1.1 seconds of boundary silence. That is a failure,
not an endurance pass. `endurance-poll-recv-terminal-failure.json` retains it.

A separate two-minute single-thread C clock/copy probe on the stopped-testbot
VM performed 763,392 tiny copies with no 2 ms overrun, 573,260 ns maximum wall
duration, and about 1.06 seconds CPU time. It did not reproduce the failure;
it is not playback evidence (`source-clock-copy-probe*`).

A temporary three-stage wall-timing patch then reproduced the terminal stop at
18:56:53.412951 UTC: 2,205 us wall and 2,210 us CPU. Receive took 2,485 ns, copy
1,062 ns, and `Notify::notify_one` took **2,191,168 ns**. It isolates this
occurrence to producer notification. That call includes both the internal
waiter mutex and the Tokio task wake; the trace does not distinguish those two.
See `source-stage-terminal-oracle.txt`, `source-stage-diagnostic.patch`, and
`endurance-stage-diagnostic-failure.json`. The diagnostic build is expressly
excluded from quality qualification. It had one positive/negative loss pair,
mid-song concealment/silence, and repeated 1.1–1.3 s boundary silence.

The next candidate replaces the consumption Notify with a single atomic permit
and AtomicWaker register/recheck. The stage instrumentation is removed. This
eliminates the waiter-list lock while preserving early consumption and the
latest waker, but still needs a live test because waking the Tokio task can
itself have scheduling cost. The CPU gate is unchanged. All 14 bridge tests pass.

The final live result is pending. No finite test guarantees future network
behavior or proves every audible source defect absent.
