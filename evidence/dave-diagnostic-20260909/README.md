# DAVE failure diagnostics and shared-instance audit

This is diagnostic work, not a fix or a successful six-hour qualification.
The previous run lost its receiver to a local network outage after 94 minutes;
the independent Oracle sender later terminated with DaveTransition at
2026-09-09T02:58:17Z. Its specific cause was not retained and cannot be recovered.
See ../six-hour-20260908/RESULTS.md for the original observations.

Oto 83c6338 preserves an allowlisted DAVE cause through both audio and connection
failure snapshots. Queue timeout, response timeout, closed owner, invalid state,
backend rejection, panic, malformed input and protocol refusal are distinct.
Arbitrary backend source text is not logged. Crust a5b208d logs this durable
metadata on lifecycle failures; no per-frame logs, audio transformations or
recovery-policy changes were added. Existing ErrorKind/failure() remain intact.

Validation: Oto 95 library tests passed, including new virtual-time deadline,
durable propagation/reset and redaction tests. Existing epoch reset, transition,
reconnection and no-plaintext-on-failure tests passed. Oto all-target clippy passed
with warnings denied. The adapter has 14 passing tests and warnings-denied clippy.
The complete Raydio suite passed 49 tests, formatting and all-target clippy
with warnings denied.

The accelerated release soak encrypted 8,640,000 maximum-size frames through
DAVE/RTP/AES-256-GCM: 48 hours of frame count, in 28.34 seconds, zero loop allocations
or reallocations. This rules out a simple failure at the previous packet count
in that fixed fixture; it does not model wall-clock expiry, live gateway controls,
receiver audio, or network conditions. A preliminary 24-hour invocation encrypted
its frames but failed the harness's required RTP timestamp-wrap assertion: 24h is
short of that wrap. The preserved failed log is a test-duration limitation, not
an encryption failure; the default 48h invocation passed that assertion.

Production Raydio (PID 876, v0.2.1) and Testbot (PID 3063 before replacement) share
one Oracle Always Free instance. Production was active, with no restarts or log
entries during the previous test window. A fresh 30.069s sample measured production
at 12.326 MiB PSS and 0.02961% of one CPU core, Testbot idle at 12.146 MiB PSS,
and 567.59 MiB available host RAM. These are fresh idle measurements, not production
samples from the failed run. Low current load does not exclude earlier short bursts.

The next host sampler retains production PID identity, CPU/PSS/RSS and host
CPU/memory/I/O pressure alongside the candidate once per minute, using the same
low-priority sampler process. A simulated-clock smoke check verified both samples
and peer identity/metrics. A changed or vanished production PID is recorded as an
error rather than silently reassigning its measurements. No production restart is
needed to collect this evidence.

A fix claim still requires the actual failure category or a deterministic
reproduction, an appropriate regression, and validation after correcting it.
A completed receiver run must also distinguish source quiet tails, packet loss,
concealment, local receiver interruption and genuine sender silence. A clean
unexplained rerun alone does not establish the cause of the previous failure.
