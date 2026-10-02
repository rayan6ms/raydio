# YouTube search and playlist failure

## Symptom

Raydio could play a direct YouTube URL through the Oracle deployment, but `/play`
searches and playlist URLs failed with the generic “could not start that track”
response. The same behavior appeared for `chop suey` and `akcent`.

## Cause

The Oracle source requests use the home-egress SOCKS proxy at loopback. Mantle's
`PublicInternetOnly` resolver applied its private-address filter to the proxy
endpoint itself, classified the SOCKS connection as `DestinationDenied`, and
returned a generic source failure. Direct URL playback did not expose this because
its metadata and media handoff used the authenticated Companion sidecar instead.

## Fix

Mantle now permits the exact configured proxy authority as an explicit private
exception. Directly resolved destination addresses remain subject to the existing
public-address filter. The regression test covers the authority match, and Raydio
pins the fixed Mantle and Crust revisions.

## Validation

The Oracle release probe passed all four cases:

- `ytsearch:chop suey` → `search`, 20 tracks
- `ytsearch:akcent` → `search`, 20 tracks
- the direct Rick Astley URL → `track`
- the existing playlist URL → `playlist`

The full Raydio suite passed 50 library tests, the main test, backend integration,
reconnect integration, and doc tests. The deployed service is active at revision
`acb385ccaa21f0f8762241102f495f5d075aa2cd`.

## Follow-up playback handoff retry

The first live `akcent` attempt reached source playback but the Companion media
handoff returned `InvalidResponse`. Crust labeled that response as the Web client
and asked Mantle for the next client. Mantle retried Companion before applying the
skip list, so the same handoff failed twice and Raydio reported its generic start
error.

Mantle revision `3b23f30` now honors a skipped Web client before entering the
Companion path, allowing the next configured playback client to run. Crust revision
`5ca95fd` and Raydio's follow-up pin carry that fix. The new Mantle regression test
proves that a skipped Web client goes directly to Android VR without another
Companion request.
