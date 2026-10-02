# Encrypted voice setup failure in an occupied channel

## Observed requests

Raydio release `acb277c` handled three user requests in THE CLUB on 2026-10-02.
The server was inspected only; development tests used local fixtures and the
approved test servers.

- 18:23:50 UTC: voice admission correctly returned the missing View Channel and
  Connect permissions. This request did not reach source loading or voice setup.
- 18:28:27 UTC, interaction `1555647672147255336`: acknowledged in 977 ms,
  admitted, and source resolution succeeded in 1633 ms. The voice connection
  processed external-sender opcode 25, then failed with `DaveTransition`,
  `InvalidState`, and an unready version-0 local DAVE context. No track started.
- 18:29:00 UTC, interaction `1555647808537632778`: acknowledged in 523 ms,
  admitted, and source resolution succeeded in 1422 ms. The same DAVE failure
  followed opcode 25. No track started.

Both playback errors completed their Discord replies, and the subsequent voice
closure cleaned up the session. This differs from the older unfinished defer.
The YouTube Web handoff warning also occurred in successful requests in test and
Romanvs; it does not explain the terminal encrypted-voice failure recorded here.

## Protocol bug and correction

[Discord's DAVE specification](https://daveprotocol.com/#commit-handling), read
again on 2026-10-02, says MLS Commit (29) and Welcome (30) carry the transition ID
for an epoch change. After applying one, the client sends Ready (23) and changes
sender keys at Execute (22). A prior protocol-version Prepare Transition (21)
is not required. This applies to a joining member's Welcome as well as commits
received by existing members.

Oto incorrectly required a pending preparation for all nonzero IDs. Its only
exception was initial transition zero. Thus a valid nonzero Welcome for a
newcomer, or a regular member-add Commit, returned `InvalidState` before MLS
validation. Generated valid messages reproduced this error on the deployed
Oto baseline. Oto now creates the pending transition from the announcement
itself, requires the external-sender context, retains conflict checks, and leaves
MLS signature, roster and group validation in the existing backend.

A second reproduced bug let a repeated Prepare for the same ID replace an
already applied Commit's preparation, discarding the staged sender-ratchet flag.
Oto now preserves that state. Transition zero retains immediate initialization;
nonzero transitions still wait for the matching Execute before activating new
sender keys. There is no plaintext fallback.

The old failure log did not retain the rejected opcode/transition ID. It proves
the failure stage, but cannot distinguish which incoming DAVE message triggered
that particular `InvalidState`. The specification mismatch is independently
reproduced and consistent with the incident. Successful Commit/Welcome diagnostics
now include their IDs, and failed controls retain their opcode in the safe
protocol-code field, so any remaining failure can be attributed precisely.

## Validation

Four new regressions failed before the state-machine change and passed afterward:

- A real generated nonzero Welcome without Prepare becomes Ready, rejects a
  mismatched Execute, activates on the matching Execute, and decrypts peer media.
- A real initial nonzero Commit without Prepare becomes Ready and remains unable
  to send before Execute.
- A real three-member group accepts the next member-add Commit without Prepare;
  the sender retains the old epoch until Execute, then the new member can decrypt.
- Repeated Prepare preserves an applied Commit and its pending sender ratchet.

Two more gateway regressions cover a generated Welcome bound to the actual
connection's one-use key package over TLS/WebSocket, readiness reporting with
the correct ID, refusal of media before Execute, successful UDP audio afterward,
and a Welcome without external-sender context failing with the retained opcode.

The full Oto workspace suite passed: 123 Oto tests, 15 testkit tests, 6 gateway
integration tests, 4 UDP integration tests, and doc tests. Nine existing manual
benchmark/soak tests remained ignored. The additional MLS fixture dependencies
are test-only and reuse the existing locked backend versions. No encoder,
source selection, media bitrate, worker, pacing, or deployment shape changed.

Oto revision `62d2fc87e5dc239695a8b86a7372a4edc1caa933` is published on
`fix/announced-mls-transitions`. Oto's full workspace Clippy check passed with
warnings denied. Crust revision `666313d2e4597f143ff3e77c412a67f25881726b`
pins that Oto revision consistently for the production adapter, testkit, and
root crypto patch. Its 16 adapter tests and doc tests passed; its one existing
manual benchmark remained ignored, and adapter Clippy passed with warnings denied.
Raydio also aligns its crypto patch and direct test dependency with the same Oto
revision.

Raydio's complete locked test suite passed: 54 library tests, its main test,
backend and reconnect integration tests, and doc tests. All-target Clippy passed
with warnings denied. Formatting and the release build passed, and the
manifest/lock diff contains only the dependency alignment. The resolved graph
contains one Oto, Davey and
crypto backend revision, including the production adapter, rather than retaining
the older duplicate test dependency.

## Deployment and live follow-up

Release `5e39ef78acc477b27367532f10840a22d76e95f2` was pushed, packaged,
and activated on the existing Oracle VM at 19:06:26 UTC. Package and remote
backend checks passed, Discord readiness completed, and the service is active
with no automatic restarts. The local and deployed binary SHA-256 match:
`914ceb2bfdec6bc6f30a6a9b04aba6844086494480c84a1be37dd8eeecb4d112`.
Testbot remains inactive, and the existing home-egress tunnel and Companion
services remain active.

The user submitted `/play` in test → #chat while joined to General. Interaction
`1555657479105417396` was received at 19:07:25 UTC, acknowledged in 565 ms,
admitted, and resolved successfully in 1483 ms. The DAVE exchange processed
external sender (25), proposals (27), and Commit (29, transition zero), becoming
ready at protocol version 1. The Web media handoff warning recovered through
the existing fallback. At 19:07:52 UTC the reply completed and the track started.
The browser showed Raydio in General, playing Akcent's “Stay With Me” at volume
70 with advancing progress; the user enabled Loop.

The short playback observation continued past five minutes. The natural finish
at 19:12:00 UTC started generation 2 without a new source load. The 19:14:28 UTC
checkpoint showed 19,860 sent frames, zero unavailable or silence frames, zero
skipped deadlines, send failures or source overruns, and zero active send gaps
over 40 ms. Voice remained connected with no DAVE failure or service restart.
This is sender/lifecycle evidence; no fresh receiver packet-loss or perceptual
audio measurement is inferred from the Discord player display.

Playback was left running during the subsequent startup investigation. At
19:31:28 UTC the extended session showed 70,846 frames, seven send gaps over
40 ms (maximum 61.981 ms), eleven skipped deadlines and no unavailable frames,
source overruns, send failures or DAVE failure. Thus the clean five-minute
window above must not be extrapolated to a gap-free longer run. The intentional
19:32 deployment restart ended this observation; shutdown silence/unavailability
counters are not a measurement of uninterrupted steady playback.

The live follow-up uses test or Romanvs only. A successful ordinary test-server
join confirms deployment and playback, but does not reproduce the historical THE CLUB control
sequence; the generated MLS and gateway regressions validate that protocol path.
