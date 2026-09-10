# EOF snapshot/event-identity regression

A real Crust REST GET can observe Mantle at EOF before the queued source-terminal
notification executes. The snapshot correctly reports `track:null`, but used to
clear the only copy of the event's userData. The resulting TrackEndEvent carried
no raydioGeneration, so Raydio ignored it and waited for its existing watchdog.

The deterministic test holds a GET snapshot while a two-frame fake source
finishes. Before the fix it fails with generation `null` instead of `103`
([before.txt](before.txt)); after the fix it passes ([after.txt](after.txt)).
This is a regression of event delivery through real REST and WebSocket surfaces,
not an audio-quality measurement or a probabilistic timing stress test.

Crust now moves completed metadata into one bounded pending-terminal slot. The
public snapshot still shows `track:null`; the slot is consumed after terminal
events are delivered, before an overtaking control changes identity/generation,
or on destruction. No track payload is cloned when the snapshot moves it.
Additional tests queue repeated snapshots and a same-encoded replacement, stop,
or seek ahead of the old terminal callback. Finished events retain generation
103, and replacement finishes with generation 104, with no cross-generation leak.

Raydio retains its generation guard and 15-second watchdog. It now logs watchdog
advancement and rejected unidentifiable terminal events using bounded fields,
without URLs, tokens or encoded media. No per-frame diagnostic work was added.
Opus encoding, bitrate, encryption, DSP, and natural tail audio are unchanged.

Validation: Crust workspace 154 passed, 0 failed, 4 ignored manual benchmarks;
workspace/all-targets Clippy with warnings denied and formatting pass.
Raydio all-targets integration: 49 passed, 0 failed. Formatting and strict
all-targets Clippy passed. The diagnostic checks passed (three collector tests,
one summary regression, and both Bun harness checks).

The release build at Raydio `9eb883bdad6f5ba52d2024ce994bdde9144d78dd`
completed, passed local and Oracle `--check`, and was deployed to the existing
Testbot unit as PID 8167. Binary SHA256:
`a665618b5a2c860555fdf3c2bbe7ecfdbd45e84bf5a67c4eb205a09cbc4127b7`.
Size: 18,596,784 bytes (4,304 bytes above the earlier candidate). This change
makes no measured memory/CPU optimization claim. Production Raydio stays disabled.

The user submitted /play after automated Enter failed to activate the slash
menu. The [five-minute live receiver test](../eof-live-20260910/RESULTS.md) then
completed with a successful natural loop, a normal 976.25 ms tail, no silent
concealment or clipping, and 273.083 ms of non-silent concealment. The sender
logged a natural finish and next start 2.047 ms apart without watchdog recovery.
This confirms ordinary deployment behavior; it does not establish six-hour
reliability or resolve the separate receiver-network incident.

The six-hour 15.624-second silence started at the normal source tail and extended
it by roughly 14.7 seconds. This reproduced race closely explains its missing
finish event and duration+15-second restart, but the old run did not capture the
terminal payload or watchdog trigger. The separate 14.826-second ICE outage is
outside this fix; a single receiver cannot establish its precise network hop.
