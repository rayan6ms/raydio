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

## Deployment

The release build and local/remote backend checks passed. Release
`319e738a65d456043aa41ae9cca55740b686ec9e` was pushed, packaged and activated on
the existing Oracle VM at 19:32:26 UTC. Discord readiness completed, Raydio is
active without automatic restarts, and Testbot is inactive. The local and
deployed binary SHA-256 match:
`4b9080e4bd1bd279f6fc06ef3c7d06dc9bb9ca54a80a5b80975bfb5384dd4332`.

## First Oracle comparison and remaining bug

The user submitted the same video URL in test. Interaction `1555664060589281530`
was received at 19:33:34.983779 UTC and the track started at
19:33:48.327052 UTC: **13,343 ms versus 26,188 ms** for the earlier request,
about 49% less wait. Both were the first playback after bot activation, though
the input method changed from a selected search result to its exact URL and the
external network/Companion cache was not controlled. This is one live comparison,
not a guaranteed latency target. Acknowledgement took 332 ms and metadata
resolution 1406 ms. The same video played and repeated naturally.

The first Web-labelled handoff still failed with `Source(InvalidResponse)`:
205 ms discovery and 3813 ms opening. That error class occurs during URL
resolution, before HTTP media input. Successful-opening timing was missing
because Raydio's logging filter did not include the source adapter's info events;
the startup event now has a specific safe target enabled by the bot.

The installed Companion revision
[`bb3b37ff`](https://github.com/iv-org/invidious-companion/blob/bb3b37ff40c69475e45785d16eb7da8876b80089/src/lib/helpers/youtubePlayerHandling.ts)
explicitly returns deciphered URLs and removes `signatureCipher`. A bounded
authenticated Oracle probe returned direct signed Opus URLs retaining `n`, with
no cipher. Mantle treated this already resolved value as a fresh Web challenge,
unnecessarily acquiring a player script and then failing before media I/O.
The regression reproduces `InvalidResponse` on the old implementation.

Mantle now records private URL provenance. Only the configured authenticated
Companion response is marked resolved; raw InnerTube and watch-page URLs retain
the ordinary cipher path. A still-unresolved Companion signature is rejected
and falls back to another client. The fix preserves the exact signed URL and
avoids a second transform or player-script request. A new deployment and live
comparison are pending this additional correction.

The correction is published as Mantle
`4bdb224ca6b32b6e6640c8cd7a4c7d72da114a52`. Its 46 YouTube regressions pass
(three existing scheduled/process exclusions), as does all-target media Clippy.
Crust `ebfc1779a0548491f8b247820b67f3c7163f1e42` pins that revision, adds the
specific startup log target, and passes 32 adapter tests plus all-target Clippy
(two existing manual benchmarks excluded). Raydio preserves all registry
versions and the Oto encrypted-voice correction while aligning its direct and
transitive dependencies with those published revisions.

With that graph, Raydio's locked 54 library tests, main test, backend/reconnect
integrations and doc tests pass. All-target Clippy with warnings denied and
formatting pass. The release and live comparison are the remaining checks.

The bounded release build and backend self-check also pass. Its binary SHA-256
is `86e151e83187e4340711c5e3ceca5eb40dedfb627bb8c1a8303daf8fd6fa02d8`.
Deployment will retain the previous release for rollback if readiness fails.

## Companion correction deployment

Release `03fad9e6db8782c322c9ac8eb494a29f3f4257da` was pushed, packaged and
activated on Oracle at 19:58:32 UTC. Package and remote backend checks passed;
the deployed binary hash matches the tested release above. Discord readiness
completed, Raydio is active with zero automatic restarts, and Testbot is inactive.
The same-video live measurement awaits the user's new command. No startup
number for this additional fix is inferred from the regression alone.

The last uninterrupted staging-only checkpoint at 19:57:37 UTC had 71,433 sent
frames, 18 gaps over 40 ms (maximum unchanged at 76.858 ms), 28 skipped deadlines,
zero unavailable/silence frames and no source/send/DAVE failure. The deliberate
19:58:30 deployment shutdown added five unavailable/silence frames and a higher
deadline count; those shutdown counters do not describe uninterrupted playback.

The earlier staging-only build continued playing during this work. At
19:46:37 UTC it had sent 38,435 frames with zero unavailable/silence frames,
source overruns, send failures or DAVE failures. It had 17 sender gaps over
40 ms (maximum 76.858 ms), 27 skipped deadlines and none over 100 ms. This
extended-window observation supersedes any assumption that its first short
window establishes gap-free steady playback. The next change is limited to
source opening and safe logs; it does not alter transport pacing or audio.
