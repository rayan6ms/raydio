# YouTube playback failure fix — 2026-09-25

Raydio could load metadata for `/play chop suey` and the supplied playlist URL, but Crust returned `400 Mantle source or playback failed` when opening playback. Mantle’s Android VR client was challenged by YouTube, while the Web response exposed metadata and format entries without usable media URLs.

The working fallback is YouTube’s VisionOS player client. YouTube only returns its media URLs when the request includes the short-lived visitor token present in the bounded embed page. Mantle now obtains that token once per source manager, validates its size and ASCII form, caches it, and sends it only to the VisionOS playback request. The request also carries the client context, HTML5 playback preference, and required client headers. No token or media URL is logged.

Validation on the local release candidate:

- `https://www.youtube.com/watch?v=Ifq4NQWwVpg&list=RDUfiYPq7-M3E&index=1`: loadtracks 200, decode 200, player update 200, playback handoff succeeded.
- `ytsearch:chop suey` (System Of A Down result): loadtracks 200, decode 200, player update 200, playback handoff succeeded.
- Mantle’s YouTube integration tests: 39 passed, 3 ignored.
- Raydio node tests: 4 passed; clippy with `experimental-audio-worker`: passed.

The fix is in Mantle `edc7fb1`, Crust `b800473`, and Raydio `a60c105`. Raydio was packaged and deployed to Oracle with `raydioctl`; the service reports `Connected to Discord` and uses 3.5 MiB immediately after restart.
