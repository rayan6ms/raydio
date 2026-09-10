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
Raydio integration, portable build and five-minute receiver validation follow
in the live-result section once complete.

The six-hour 15.624-second silence started at the normal source tail and extended
it by roughly 14.7 seconds. This reproduced race closely explains its missing
finish event and duration+15-second restart, but the old run did not capture the
terminal payload or watchdog trigger. The separate 14.826-second ICE outage is
outside this fix; a single receiver cannot establish its precise network hop.
