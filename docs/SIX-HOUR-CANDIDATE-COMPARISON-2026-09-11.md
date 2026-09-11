# Six-hour candidate comparison — 2026-09-11

The transport-improvements candidate was started on Oracle at 02:35:25 UTC with
Testbot playing the 213-second track in General on Loop. The receiver observed
13,022.7 seconds (3 h 37 m), not the requested 21,600 seconds. At 06:12:27 UTC,
Ubuntu's unattended `apt-daily-upgrade` transaction reexecuted systemd and
stopped the active service while restarting system services. Testbot's automatic
restart raced network initialization and failed Discord authentication. A
manual start at 10:45:36 UTC authenticated successfully. The run is therefore
an interrupted observation, not a six-hour pass.

| Metric | Previous six-hour baseline | Candidate recorded window | Rate comparison |
|---|---:|---:|---:|
| Receiver time | 21,600.0 s | 13,022.7 s | incomplete |
| Packets received | 1,078,984 | 649,461 | — |
| Net lost packets | 47 | 20 | 0.131 → 0.092/min (−29.5%) |
| Concealment | 46,066 ms | 46,052 ms | 128.0 → 212.2 ms/min (+65.8%) |
| Silent concealment | 13,509 ms | 26,356 ms | 37.5 → 121.4 ms/min (3.24×) |
| Discarded packets | 567 | 327 | — |
| NACKs | 2,074 | 891 | — |
| Sender gaps ≥40 ms | 228 | 191 | 38.0 → 52.8/hour (+38.9%) |
| Sender gaps ≥100 ms | 0 | 4 | 0 → 1.11/hour |
| Skipped deadlines | 282 | 387 | 47.0 → 107.0/hour (+127.6%) |
| Send failures / source overruns | 0 / 0 | 0 / 0 | unchanged |
| Bot PSS median | 16.65 MiB | 16.37 MiB | −1.7%, within measurement variation |
| Bot CPU | 4.004% | 4.018% | effectively unchanged |

The lower candidate loss count is not a valid improvement claim because its
window is 40% shorter and the observations experienced different network
conditions. The candidate's concealment rate was higher, dominated by receiver
path incidents rather than a sender error. The largest event included ICE and
connection `disconnected` states for about eight seconds and 14.7 seconds of
off-boundary quiet; the sender reported no send failure or source overrun at that
time. This identifies a downstream Discord/WebRTC interruption, not a fixable
audio scheduling defect in the bot. Track-loop handoffs were separately logged
and classified as boundary events.

Oracle recorded zero UDP receive-buffer errors, send-buffer errors, checksum
errors, OOM events, or cgroup memory pressure. The apparent end-of-run silence is
the direct consequence of systemd stopping the sender and the receiver losing
its peer; it must not be counted as normal playback quality.

For a valid six-hour comparison, pause unattended upgrades and other planned
maintenance for the bounded test window, start the host sampler under a
supervised service, and restore those timers afterward. Keep the Testbot unit's
restart policy separate from the production Raydio unit. The immutable receiver
report and summary are stored under
`evidence/transport-improvements-20260911/full-candidate-six-hour-20260911`.
