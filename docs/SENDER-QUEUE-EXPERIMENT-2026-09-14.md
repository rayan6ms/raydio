# Independent sender queue experiment — 2026-09-14

## Correction — 2026-09-15

**The timing results below do not establish the benefit of bounded buffering
in the real bot.** The candidate precomputed and DAVE-encrypted the entire
stream into a `Vec<Prepared>`, then a second native producer thread fed the
eight-slot queue. Blocking Tokio did not block that producer. This explains
why a nominal 160 ms queue appeared to cover a 250 ms stall.

The 20,800-byte figure counts only the ring slots. It excludes the full prepared
stream (481,000 bytes for 185 frames), the feeder thread and its stack, DAVE,
task state, buffers, and receiver instrumentation. The allocation measurement
used plain prepared packets and excluded source/DAVE preparation. The lifecycle
test covers an explicit prototype fence, not production gateway/reconnect
ordering. Intervals are loopback receiver arrival times, not kernel send times
or decoded-audio quality measurements. The JSON was manually transcribed;
it is not a raw capture.

The observations below are retained as historical evidence only. A replacement
benchmark must prepare incrementally on Tokio, stop production during the
injected runtime stall, account for all bounded in-flight frames, and expose
underflow when a stall exceeds available audio. Production remains unchanged.

## Replacement evidence

The corrected, incrementally produced channel/DAVE tests and matched Oracle
loopback runs are documented in [SENDER-QUEUE-VALIDATION-2026-09-15.md](SENDER-QUEUE-VALIDATION-2026-09-15.md).
Raw logs are in `evidence/sender-queue-20260915/`. The eight-slot experiment
correctly exposes underflow once runtime stalls exceed its prepared capacity.
No production integration, Discord receiver run, or six-hour test is implied
by those experiments.

## Historical experiment (superseded for promotion decisions)

This is the measured decision spike for the native-style sender queue. The
production Raydio service and the deployed Oto pin were not changed.

The experiment uses the real pinned Oto audio/DAVE/transport primitives. A
bounded queue holds eight already DAVE-prepared 20 ms frames. A separate sender
thread owns the pacing clock and the transport RTP/AEAD encoder. Sequence
numbers and transport nonces are assigned only when the sender transmits a
frame. The receiver runs on a separate loopback thread and captures every RTP
packet for order and interval checks.

The test also exercises a generation fence: queued frames are returned to the
owner for re-encryption at a DAVE epoch boundary. Pause/resume does not burst
old deadlines; stop and source replacement cannot consume RTP numbers for
frames that were never sent.

## Release results

Pinned Oto revision: `e205f9a3f44be36fab2fa3cd48ef113cbb0f4d1f`, Rust 1.97.1,
release profile, 180 music frames plus five terminal silence frames.

| Scenario | Current sender | Independent queue |
|---|---:|---:|
| Normal, maximum interval | 21.500 ms | 20.463 ms |
| Normal, gaps ≥40 ms | 0 | 0 |
| Tokio runtime stall 100 ms, maximum interval | 103.364 ms | 20.121 ms |
| Tokio runtime stall 100 ms, gaps ≥40 ms | 1 | 0 |
| Tokio runtime stall 250 ms, maximum interval | 251.260 ms | 20.132 ms |
| Tokio runtime stall 250 ms, gaps ≥40 ms | 1 | 0 |
| Sender-thread stall 100 ms, maximum interval | — | 100.192 ms |
| Sender-thread stall 100 ms, gaps ≥40 ms | — | 1 |

Every scenario delivered 185/185 packets. The queue path preserved RTP
sequence/timestamp/nonce order and the exact DAVE-prepared payload. The
generation, re-key, pause, stop and replacement regression passed. A warmed
queue transport test measured zero allocations, reallocations, and allocated
bytes over 100 frames.

The queue storage is 20,800 bytes for eight fixed slots. The prototype requests
a 256 KiB sender-thread stack. These are partial component costs, not upper
bounds for the spike or a production memory budget; see the correction above.

## Interpretation

The candidate protects against a short pause of the Tokio runtime **when the
queue has already been filled by the producer**. It does not repair a sender
thread stall, host CPU steal, Discord path loss, or receiver-side loss. The
production integration therefore needs a source-prefetch stage that fills the
bounded queue while preserving DAVE epoch fences, source generations,
pause/stop semantics, and bounded overflow behavior. The test-only prototype
does not replace `PacedAudioSender` yet.

Implementation and tests are on Oto branch
`experiment/independent-sender-queue`, commit `6c3e982`:

<https://github.com/rayan6ms/oto/tree/experiment/independent-sender-queue>

No Oracle deployment or Discord test was performed from this branch. Promotion
requires integrating the queue behind Oto's existing lifecycle owner, then
running Oto, Crust adapter, Raydio release, and a matched Oracle receiver test.
