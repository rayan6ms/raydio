# DAVE epoch recovery — 2026-09-10

The previous Oracle attempt stopped at 05:56:38 UTC with
`DaveTransition / InvalidState`, active version 0, no pending transition, and
readiness false. The user confirmed that their Starlink dish rebooted for an
update, explaining the earlier receiver network interruption. That does not
excuse the subsequent permanent bot playback failure.

## Reproduced cause

Oto checked the gateway's Connected phase before polling/sending a frame. The
separate DAVE owner could then process Prepare Epoch (epoch 1) or invalid-commit
recovery, clearing the encryption context. The gateway publishes its phase after
awaiting the control and outbound messages. A queued audio encryption request
therefore could reach an unready owner despite having passed the earlier check.
All encryption errors, including temporary not-readiness, were classified fatal.
Crust reported a closed voice connection, and Raydio cleaned up the session.

`reproduction-before.txt` captures a failing deterministic test against Oto
831d5e2. A real DAVE fixture is ready, the sender begins its Speaking handshake,
then Prepare Epoch resets the owner before media encryption. The sender fails
with exactly the live error/context. The fixed test remains nonfailed, sends no
plaintext, and accepts Stop within the test's 100 ms deadline.

This proves a code defect with the observed failure mechanism. The historical
log lacks the triggering opcode, so it cannot distinguish Prepare Epoch from
invalid-commit recovery for that particular live occurrence. The initial receiver
outage preceded this bot failure and is not attributed to the race.

## Implementation

- Oto 352fa9a: the encryption owner returns a distinct temporary NotReady outcome
  in the same serialized turn as the readiness decision. Actual crypto/backend,
  malformed protocol, downgrade, queue and owner failures remain errors.
- The sender observes the DAVE readiness watch as well as connection state. It
  pauses pacing and resumes on readiness without relying on an intermediate
  gateway phase being delivered. There is no periodic retry worker or spin loop.
- The one unsent frame stays in the existing frame buffer. No extra audio queue
  or re-encoding is added. Stop and replacement invalidate it; transport renewal
  and rekey preserve it. No plaintext fallback is introduced.
- A same-transport rekey retains knowledge of Speaking, so Stop clears it and
  resumption avoids a redundant gateway round trip. A rekey during the final
  silence drain resumes the normal bounded tail rather than leaving Speaking set.
- Bounded lifecycle events expose only opcode, generation and readiness/version
  before/after. Crust logs them on state changes, and the receiver analyzer retains
  both contexts through the requested test window, even after receiver failure.
  No keys, control payloads or per-frame logs are collected.

## Verification

Oto library suite: 103 passed, 6 existing manual/performance tests ignored.
Clippy for all Oto targets passes with warnings denied. Regressions cover an epoch
reset during Speaking, an epoch reset queued ahead of an in-flight frame, resumed
source delivery for callback and owned-channel inputs, replacement during rekey,
responsive Stop, and rekey during the terminal silence drain. The gateway test
also verifies opcode 24 and old/new readiness in the lifecycle event.

The integrated Crust workspace passes 160 tests (4 existing ignored); Clippy
passes for all workspace targets. Crust 4a05a7d pins Oto 352fa9a and logs the new
safe lifecycle events. Mantle is unchanged.

Four sequential release benchmarks used an A-B-B-A order, a one-second warmup
and ten-second measurement with the owned-channel, DAVE and loopback UDP path.
Every run produced/received 501 frames (measurement-boundary timing) with zero
allocations and reallocations. Before maximum lateness was 2.037/1.678 ms; after
was 1.957/1.904 ms. This does not show a consistent latency improvement or a
meaningful pacing regression. It confirms retained allocation-free steady-state
sending; it does not measure process memory savings. Candidate-only recovery tests
also passed in the exact release benchmark binary. Binary hashes and raw counters
are in benchmarks.json; no parallel builds ran during these measurements.

Raydio passes all 49 tests and all-target Clippy. The release was deployed to Oracle as Testbot PID 10564, using the existing
isolated service; production Raydio remains inactive/disabled. Package checksums,
exact running-binary hash and `--check` passed. Build revision 20f1cec has an
18,625,168-byte binary (+5,920 bytes versus the prior release) and a 7,570,715-byte
archive (+2,628 bytes). No runtime helper, codec setting or dependency was added.

Live receiver validation is pending manual submission of `/play` in Discord:
the controlled browser is authenticated and joined to General, but automated Enter
still does not submit. A separate five-minute recording and both host samplers are
prepared; no new six-hour observation is running. Local deterministic recovery
and release performance evidence above is complete; a live recovery or quality
pass is not claimed before the receiver test.
