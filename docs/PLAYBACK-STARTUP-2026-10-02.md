# Slow cold playback startup

## Oracle baseline

The user's search-result selection played the official Akcent “Stay With Me”,
YouTube video `4moWSMi1L_4`, in test → General on release `5e39ef7`.
Interaction `1555657479105417396` shows:

| Stage | UTC | Time since command receipt |
| --- | --- | ---: |
| Command received | 19:07:25.888742 | 0 ms |
| Acknowledged | 19:07:26.453966 | 565 ms |
| Source resolved | 19:07:27.937996 | 2,049 ms |
| Encrypted voice ready | 19:07:28.283041 | 2,394 ms |
| First Web media handoff failed | 19:07:33.466290 | 7,578 ms |
| Reply completed and track started | 19:07:52.076256 | 26,188 ms |

Voice setup is not the dominant wait in this request. The old logging cannot
separate later discovery/cipher, network staging and decoder-open costs.
Crust now reports each attempted handoff's discovery and opening durations,
selected client, failed-handoff count and total preparation time. It logs no
credentials, cookies, signed media URL or audio payload. Logs occur only during
source opening, outside steady audio delivery.

## Bounded staging improvement

The first HTTP range previously established the object length, then finite
staging fetched every subsequent 256 KiB window separately. Mantle now keeps
the first bounded probe and fetches the stageable object's remaining bytes in
one request. Bytes still flow through the existing 64 KiB copy buffer into an
anonymous file before playback. Limits, cancellation, validators and body
recovery remain enforced; streaming and oversized-object behavior is unchanged.

A controlled 4 MiB source injects 20 ms of latency per request and verifies
identical staged bytes after the origin shuts down:

| Version | HTTP requests | Measured open time |
| --- | ---: | ---: |
| Before | 16 | 372.728 ms |
| After | 2 | 72.658 ms |

That is 87.5% fewer requests and about 80.5% lower open time in this simulated
latency fixture. It does not predict the total Oracle startup improvement.
Additional regressions verify exact-offset recovery from a truncated remainder,
rejection of a changed object, cancellation, origin-independent replay and
oversized streaming fallback. Mantle's media suite and all-target Clippy pass.

The deployed Oracle comparison will be recorded after a fresh user-submitted
command for the same video. Natural Loop replay is not a cold-start comparison:
it reuses the already staged file and avoids media discovery and downloading.

## Integration validation

Mantle revision `812492b99fd5414c4421813138b9805f9de39cab` and Crust revision
`054a8193eccc6ed453f5051c76e1284f60079da6` are published. Crust's 32 adapter
tests and doc tests pass, with two existing manual benchmarks ignored. All-target
adapter Clippy passes with warnings denied. Raydio's locked 54 library tests,
main test, backend and reconnect integrations, doc tests, all-target Clippy and
formatting pass. The final lock diff retains registry versions and only updates
Crust/Mantle revisions. The corrected Oto/DAVE revision remains in use.
