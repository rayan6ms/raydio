# Progressive buffering and packet timing audit

## Current-build baseline

Raydio, production binary `bc6131dabfe01ce30554f7013d9d3eeffb40f326`, ran
alone on Oracle. Testbot was stopped. The user submitted the same Akcent URL
(`4moWSMi1L_4`) and enabled Loop at volume 70. The receiver observed five
minutes, 22:27:27.436–22:32:27.437 UTC on 2026-10-02. No builds, source probes,
restarts or playback controls occurred in that window.

| Measurement | Complete staging baseline |
| --- | ---: |
| Received packets | 14,997 |
| Net / positive lost packets | 0 / 0 |
| Discarded packets / NACKs | 2 / 9 |
| Concealed audio | 79.6875 ms |
| Silent concealed audio | 0 ms |
| Non-boundary quiet intervals ≥100 ms | 0 |
| Clipped / nonfinite PCM samples | 0 / 0 |
| Sender gaps ≥40 / ≥100 ms | 1 / 0 |
| Maximum sender gap | 72.219 ms |
| Bot CPU, one core equivalent | 4.148% |
| Bot PSS range | 16.187–16.335 MiB |

Receiver polls, PCM, events and connection coverage are complete. Sender traces
contain 18,876 records spanning the recording and startup, with no dropped,
missing, conflicting or reversed records and no RTP sequence/timestamp jumps.
The Oracle and receiver host samplers have continuous one-second coverage.
There were no UDP errors, cgroup throttling, OOM events or receiver long tasks.
The earlier source reference attributes about 2.197 s quiet to tail plus head;
the 2.266 s loop-boundary quiet agrees within 69 ms. That remains a candidate
source boundary, not discarded evidence or a guarantee of perfect delivery.

## What the timing identifies

The one 72.219 ms send gap at 22:31:41.192313 UTC records 54.127 ms wake
lateness. Source polling was 2 µs, DAVE round trip 39 µs, transport crypto 7 µs
and UDP wait 32 µs. The following one-second host sample shows 6.468% CPU steal,
with no cgroup throttle. This supports host scheduling as the sender delay,
not a slow media callback or encryption. It overlaps the 24.208 ms concealment
window. Other smaller concealment/discard windows have no traced ≥40 ms send
gap; the one receiver cannot isolate Discord forwarding from its network/client.
The adjacent 27.542 ms concealment poll may be part of the same recovery, but
falls outside the fixed correlation window; overlap is not proof of causation.

The source was already completely staged during the receiver recording.
Progressive buffering targets startup, not these downstream discards. No
speculative encoder, bitrate, volume, queue or pacing changes are justified.

## Startup bottleneck and implementation

The baseline command arrived at 22:26:19.772654 UTC. Media response setup took
967.694 ms, then complete staging 4,715.639 ms. First traced successful send was
22:26:26.518100 UTC: **6.745446 s after command receipt**. The logged TrackStart
was processed at 22:26:26.820840 UTC, after the Discord response. Successful
send is a better sender startup measure, but does not measure first audibility.

Raydio's candidate starts finite inputs after 256 KiB have been cached, while
an owned downloader completes the same anonymous file. The cache ceiling stays
16 MiB; larger/live inputs retain their previous path. The environment setting
`RAYDIO_PROGRESSIVE_BUFFER_KIB` accepts 16..1024, or zero for complete staging.
Mantle/Crust defaults remain opt-in. All bytes, container validation, proxy and
authentication policies, deadlines and retry checks are retained.

Regressions also exposed and fixed eager WebM metadata/index work that would
otherwise defeat the early cache. Optional metadata uses the available prefix;
tail indexes are deferred until an explicit seek. That seek completes the same
cache and commits a fresh indexed reader only after success. Ordinary filters,
codec/encoder resets and completed offline repeats remain in place.

The controlled 128 KiB delayed-remainder comparison opened in 404.266 ms with
complete staging versus 2.154 ms progressively. A real WebM fixture delivers
an exact first Opus frame before the held remainder, then every packet and
timestamp matches the local reference. It also preserves playback on a failed
seek and supports backward seek after EOF. This is controlled preservation and
latency evidence, not a measured live Oracle improvement yet.

The proxy audit also reproduced a broken SOCKS timeout: a 200 ms deadline
returned after 701.061 ms when the mock proxy finally closed. Mantle now performs
bounded SOCKS setup on Ureq's existing TCP transport and retains its connection
pool and TLS. This removes the helper-thread wait and unused SOCKS dependency
closure. Protocol/auth/DNS/IPv6, fragmented replies and pooled bytes have
regressions. The release locks also update Rustls to 0.23.45 and WebPKI to
0.103.15 for RUSTSEC-2026-0285, so live comparisons include that transport patch.

## Automated validation

Mantle `7c7762d`: 241 media tests pass, with eight pre-existing manual fixtures
ignored; all-target media Clippy and release advisory/license/source/Cargo Vet
gates pass. Crust `ebc863a`: 33 adapter/filter tests pass, with two pre-existing
manual cases ignored; all-target adapter Clippy passes with warnings denied.
The gated real WebM comparison preserves every packet and timestamp, emits its
first frame before the held remainder, and covers failed and backward seeks.
The SOCKS deadline reproduction improves from 701.061 to 207.179 ms against a
200 ms budget (scheduling tolerance applies).

Raydio's 58 Rust tests and all-target Clippy pass with warnings denied. Its
34 Python diagnostic tests pass. Bun tests cover the checkpoint rearm,
actual PCM meter arithmetic and six-hour collector simulation. These tests are
independent of live quality. Faster host sampling is bounded to short runs and
smaps traversal remains at most once per ten seconds.

## Qualification

Qualification uses the same user-submitted playback, five-minute untouched
receiver recording and sender/host timing collection. Compare command receipt
to first send, prefix/completion phases, source waits, receiver loss/discards,
concealment, PCM continuity and memory. Keep zero-prefix/full-stage rollback
available. A prefix is protection against ordinary short source stalls; it
cannot prevent starvation if sustained throughput drops below playback demand.

Evidence: `progressive-buffering-20261002/baseline/`. Optional diagnostics are
the existing bounded Oto header/timing trace, one-second procfs samples and
aggregated receiver statistics, never payload interception or stored PCM.
Both clocks report NTP synchronized; exact inter-host offset remains unmeasured.

## Live Oracle comparison

Raydio `80f4ec627181171d224d5d3389cd2a86c553c578` was atomically deployed
with successful backend and Discord readiness checks. The unchanged baseline
and candidate used the same public source, volume 70, Loop, Oto revision, audio
worker, codec and pacing. The native package is 7.3 MiB. Testbot stayed stopped.

The first candidate recording completed from **23:30:58.693–23:35:58.694 UTC**.
The observer started after the fresh matching player showed Playing and Loop ON;
persistence verification checked the actual advancing report. Both sampler paths,
receiver polls/PCM/events and sender traces cover the full five minutes. A second
untouched sample ran from **23:38:27.439–23:43:27.441 UTC**, without a restart,
source probe or playback control between samples. Its event/PCM coverage is
complete, but its connection was not uninterrupted.

| Measurement | Complete-stage baseline | Progressive candidate | Continuing-playback recheck |
| --- | ---: | ---: | ---: |
| Command → first successful send | 6.745446 s | **3.713194 s** | no fresh command |
| Initial compressed buffering | 4715.639 ms | **279.813 ms** | already cached |
| Media response setup | 967.694 ms | 1531.329 ms | no source reopen |
| Received packets | 14,997 | 14,992 | 14,274 |
| Net lost packets | 0 | 0 | -37 (corrections, not improvement) |
| Positive / negative loss deltas | 0 / 0 | 1 / -1 | 27 / -64 |
| Discards / NACKs | 2 / 9 | 3 / 17 | 41 / 25 |
| Concealed audio | 79.6875 ms | **247.75 ms** | **15,649.958 ms** |
| Silent concealed audio | 0 ms | 0 ms | **14,967.771 ms** |
| Sender gaps ≥40 / ≥100 ms | 1 / 0 | 4 / 0 | 9 / 0 |
| Largest in-window sender gap | 72.219 ms | 64.820 ms | 61.470 ms |
| Playback PSS median | 16.194 MiB | 16.593 MiB | 16.679 MiB |
| Bot CPU, one core equivalent | 4.148% | 3.851% | 3.818% |
| Clipped / nonfinite samples | 0 / 0 | 0 / 0 | 0 / 0 |

Startup improves by **3.032252 s (44.95%)** in this single paired observation.
The first successful send was at 23:30:49.125897 UTC; the owned downloader
finished later at 23:30:52.972180 UTC, with every 4,167,934 source byte available
and no failure. Thus playback began before the complete source was downloaded.
Only the initial prefix wait was logged; source delivery did not stall afterward.
Median playback PSS increases by about **0.398 MiB**, rather than decreasing.
CPU figures are descriptive; the different host conditions preclude a causal
CPU improvement claim. All comparison rows above retain the actual observations.

## Incident attribution and limits

The first candidate's four sender gaps cluster at **23:33:42 UTC**. Source polls
were 1 µs, with 39–46 ms wake lateness. The corresponding one-second host sample
shows **24% CPU steal**. The downloader had exited roughly three minutes earlier.
This points to host scheduling, not waiting for progressive source bytes. The
cluster overlaps a 120.292 ms concealment poll. Smaller incidents without a
≥40 ms sender gap remain downstream/client-path uncertainties. The first run
has no silent concealment, clipping or off-boundary PCM quiet ≥100 ms.

The recheck's nine gaps cluster around **23:40:02 UTC**, alongside **34.742% CPU
steal**. Most delay lies in waking the sender; one record waits 38.681 ms for DAVE
and another 38.282 ms for UDP completion. Encryption CPU remains microseconds,
so these wall waits alone do not identify slow cryptography. Source polling stays
at 1–21 µs, with no source underruns, source overruns or send failures. The bot's
CPU usage also rises during those samples; steal identifies VM contention but
is not, by itself, proof of the complete scheduling cause.

A separate short receiver interruption at **23:40:12 UTC** reports 27 temporarily
lost packets, corrected by -27 next poll, and a 130.313 ms quiet interval. In
23:40:11.439–23:40:14.439 UTC the sender submitted **150 packets**, with a maximum
20.816 ms interval and no silence packets. This is delayed reception beyond the
sender's successful submission, not evidence of source starvation.

The largest recheck interruption is **14,767.125 ms** off-boundary PCM quiet,
ending around **23:41:27 UTC**. The browser reports ICE/connection disconnected
at about 23:41:17 and reconnected around 23:41:27; zero incoming packets started
before ICE declared the failure, consistent with its grace period. Oracle
submitted **850 packets over 17 seconds** spanning this incident, with no source
change, no silence packets, and a maximum 31.920 ms send interval. There was no
receiver long task or missing PCM/poll coverage. This attributes the audible
outage to a receiver connection failure beyond successful bot submission; it
cannot distinguish the user's access network, Discord forwarding or another hop.
The user was asked whether their home connection briefly interrupted. Negative
loss corrections during recovery are retained, not presented as successful
loss prevention. This recheck **fails uninterrupted receiver qualification**.

All song-boundary quiet is retained. The first candidate has 2257.146 ms quiet
matching the 2196.979 ms tail/head reference within the existing 100 ms tolerance,
but an overlapping receiver discard keeps it classified as
`boundary-quiet-with-overlapping-anomaly`. It is not counted as proved mid-song
source failure or silently excluded. Both recheck natural boundaries match the
reference without an overlapping anomaly. Its off-boundary quiet remains a
failure and is explicitly reported.

## Decision and diagnostic integrity

Keep the bounded prefix for its demonstrated startup benefit and deterministic
packet/timestamp preservation. This is **not a clean live no-degradation pass**:
concealment/discards increased in the first run, and the recheck lost its receiver
connection. The timing identifies scheduling and receiver-path problems rather
than a reproduced cache defect. There is no evidence justifying a codec/bitrate,
gain, pacing or buffer-capacity change from these samples. A clean repeated
comparison under stable connectivity would be needed to claim unchanged live
reception quality. Zero-prefix complete staging and the previous release remain
available for comparison/rollback.

The service logs are pinned to candidate process **33541**, not just the unit/time
range: a unit-level query around deployment also includes the outgoing old
process's final trace batch. Mixing it would corrupt first-send attribution and
produce misleading missing-record counts. Candidate-only logs start with trace
record 1 and show no missing, dropped, conflicting or reversed records, nor RTP
sequence/timestamp jumps. Correlation retains missing coverage and cannot prove
which downstream hop delayed or discarded packets.

The candidate cgroup did not export throttle counters, so corresponding incident
fields remain null rather than zero. The service's CPU quota is unlimited and
its parent slice reports `max 100000`; these configuration observations are not
a substitute for missing time-series counters. Both samplers retained their real
one-second cadence, with memory traversal limited to once per ten seconds.

Successful UDP submission is not first audibility. Only one fresh startup was
measured per build, and response/network setup varied. The candidate receiver
recording began after cache completion, so initial progressive delivery is
covered by sender timing and deterministic gated-WebM tests, not receiver PCM.
The source quiet reference comes from the earlier exact-byte decode, not a new
waveform recording. Neither five-minute run proves six-hour reliability.

Evidence is preserved in `progressive-buffering-20261002/candidate/` and
`progressive-buffering-20261002/recheck/`, including raw final receiver reports,
checkpoints/events/windows, sender/host traces, summaries, correlation and source
reference. Credential/signed-URL scans passed before publication.

After both recordings were saved, the checkpoint/host collectors stopped and the
temporary trace override was removed. One normal restart disables the existing
process's trace and ends looping test playback. Production remains on the tested
progressive build, with Testbot stopped and the full-stage release retained for
rollback. No restart or control occurred inside either measured window.
