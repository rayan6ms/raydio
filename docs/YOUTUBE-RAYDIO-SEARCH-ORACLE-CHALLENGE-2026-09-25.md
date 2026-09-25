# Raydio search and playlist failures on Oracle — 2026-09-25

Raydio's direct `dQw4w9WgXcQ` track succeeds on the Oracle VM, but the video IDs returned by the reported search and mix requests are rejected by YouTube during playback discovery. The source metadata and encoded-track decode requests succeed; the failure occurs when Mantle asks YouTube for playable formats.

The Oracle VM returned `LOGIN_REQUIRED` with the bounded reason `Sign in to confirm you’re not a bot` for the Chop Suey result IDs (`CSvFpBOe8eY`, `-cid1qHuy_U`) and the mix entry (`UfiYPq7-M3E`). This was reproduced both through Raydio's embedded Crust endpoint and by direct VisionOS player requests from the VM. The same VisionOS requests from the development connection returned playable formats, so this is an egress-IP policy challenge rather than a malformed Raydio interaction or encoded track.

Raydio now prefers ordinary `ytsearch:` for search terms and retains `ytmsearch:` as a metadata fallback. This avoids selecting YouTube Music's official-audio result when ordinary search provides a usable video, but it cannot bypass an Oracle egress challenge that applies to every candidate for that IP. A complete server-side workaround requires a permitted authenticated YouTube/proof-of-origin credential or a different egress route; no credential is stored in this repository.

Validation:

- `dQw4w9WgXcQ` through Oracle: load, decode, and player update succeed.
- `CSvFpBOe8eY`, `-cid1qHuy_U`, and `UfiYPq7-M3E` through Oracle: source playback returns the bounded Mantle failure.
- Local Mantle/Raydio probe: ordinary search and playlist metadata/decode paths remain valid.
- Raydio resolver tests pass, including ordinary-search-first ordering.
