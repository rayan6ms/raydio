# Playlist playback stopped after partial downloads — 2026-10-03

## Incident and cause

THE CLUB / comandos reported three consecutive track failures at 12:47 São
Paulo time, followed by idle disconnect at 12:49. Raydio did not crash or restart
(Oracle PID 34605, zero service restarts). The reported input was the YouTube
playlist `PLiqVPtLMK7NypiXPyWSgDr9dQTbnKz2fZ`, starting at `4kae32uj7dA`.

Oracle journal establishes the download → cache exhaustion → failure sequence:

| Generation | Start UTC | Source bytes | Cached at failure | Download elapsed | Track exception UTC / playback position |
| --- | --- | ---: | ---: | ---: | --- |
| 20 | 15:44:10.297 | 12,553,041 | 933,888 | 29.092 s | 15:45:07.054 / 55.720 s |
| 21 | 15:45:16.958 | 13,179,454 | 950,272 | 28.816 s | 15:46:14.820 / 57.220 s |
| 22 | 15:46:24.628 | 14,141,030 | 933,888 | 28.992 s | 15:47:21.969 / 56.560 s |

An earlier generation 16 cached 7,602,128 of 7,919,055 bytes before the same
timeout and failed later at playback position 461.880 s. The downloader remained
subject to the ordinary 30-second request limit, even when it continued receiving
bytes. The ~32 KiB/s transfer rate in the three later tracks could stay ahead of
audio consumption, but could not download each whole object in 30 seconds.
The cause of the lower upstream throughput is not established by these records.

Mantle's socket-origin regression reproduced TimedOut at 49,152 bytes from a
healthy 128 KiB source delivering 16 KiB every 100 ms with a 250 ms short timeout.
Extending only the body budget still failed with Ureq 3.4.0: its completed header
phase deadlines incorrectly applied during body reads. Ureq 3.4.2 includes the
upstream phase-budget fix introduced in 3.4.1.

## Correction

Progressive caches use a distinct 30-minute total download budget, validated
nonzero and at most one hour. An absolute deadline survives recovery. Setup
retains short phase budgets, body reads retain the ordinary timeout as an
inactivity limit, and cancellation polls at 100 ms. Default complete staging and
ordinary range streaming retain their short deadline. The source bytes, codecs,
volume, prefix, memory limits and sender pacing are unchanged.

The three-failure policy remains: genuinely failed sources cannot loop forever.
Lifecycle diagnostics now include guild ID and queue length; source failures
also include track duration and previous failure count, without credentials,
exception text, source URLs or encoded tracks.

## Verification

The paced-origin regression now returns every byte after roughly 0.7 seconds,
past the short deadline. Negative regressions cover inactivity, continuous
trickling past the total deadline, ETag recovery unable to reset that deadline,
and complete staging retaining its original deadline. Existing range identity,
truncation, cancellation, replay, proxy and media tests remain required.

Mantle media all-target tests pass (existing live/environment exclusions
unchanged); Clippy passes with warnings denied. Advisory/license/Cargo Vet
gates pass, with reviewed Ureq 3.4.0 → 3.4.2 and protocol 0.6.1 → 0.6.4 delta
audits and no exemptions. Deployment and live playlist evidence follow below.

This fix addresses the demonstrated permanent stop. Sender scheduling delays,
downstream packet loss and receiver concealment require their own measurements;
an incidental short live check cannot establish six-hour reliability.
