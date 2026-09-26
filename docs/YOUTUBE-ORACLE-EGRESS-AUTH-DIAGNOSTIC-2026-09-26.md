# YouTube playback diagnostic on Oracle — 2026-09-26

The failed `chop suey` request was reproduced on the Oracle host with the resolved
video `CSvFpBOe8eY`.

Search, metadata decoding, and track decoding all succeeded. Playback discovery
then tried the configured clients and received YouTube playback responses without
formats. The Oracle service has a valid OAuth refresh token: refreshing it returned
an access token. The OAuth TV request returned `UNPLAYABLE` (“The page needs to be
reloaded”), while unauthenticated clients returned `LOGIN_REQUIRED` (“Sign in to
confirm you’re not a bot”). A known-good public video (`dQw4w9WgXcQ`) still plays
through the Android VR client from the same host.

This distinguishes an Oracle egress challenge from an expired token, a malformed
encoded track, or a Discord voice failure. Retrying clients cannot remove a
YouTube policy decision applied to that egress address. The adapter now preserves
`LoginRequired` as an explicit error, and Raydio reports a targeted message rather
than claiming that it merely failed to start.

No credential, access token, cookie, signed URL, or response body containing secret
material is stored in this document.
