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

The candidate needs the same user-submitted playback, five-minute untouched
receiver recording and sender/host timing collection. Compare command receipt
to first send, prefix/completion phases, source waits, receiver loss/discards,
concealment, PCM continuity and memory. Keep zero-prefix/full-stage rollback
available. A prefix is protection against ordinary short source stalls; it
cannot prevent starvation if sustained throughput drops below playback demand.

Evidence: `progressive-buffering-20261002/baseline/`. Optional diagnostics are
the existing bounded Oto header/timing trace, one-second procfs samples and
aggregated receiver statistics, never payload interception or stored PCM.
Both clocks report NTP synchronized; exact inter-host offset remains unmeasured.
