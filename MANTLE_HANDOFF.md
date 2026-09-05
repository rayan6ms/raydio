# Mantle blocker for the Raydio Rust rewrite

Please investigate and fix this reproducible YouTube source-loading regression in Mantle.
Do the implementation in the Mantle project; Raydio is intentionally paused at this dependency boundary.

## Reproduction and evidence

On 2026-09-05, on the same host/network, with no OAuth/cookies/PO tokens:

| YouTube video ID | Lavalink 4.2.2 + youtube-source 1.18.2 | Mantle default source manager |
|---|---|---|
| `dQw4w9WgXcQ` | `track` | `track` |
| `5NV6Rdv1a3I` | `track` | `SourceFailure` |
| `kJQP7kiw5Fk` | `track` | `SourceFailure` |

The original Raydio configuration uses MUSIC, ANDROID_VR, WEB, WEBEMBEDDED, in that order.
Mantle's default client order is the same. The failure reproduces with ANDROID_VR alone;
WEB alone fails for all three. These observations do not establish the underlying HTTP/parser
cause; investigate that before choosing a fix.

The failure is present directly in `YoutubeAudioSourceManager::load`, with no Crust, bot, Discord,
voice permissions, or queue code in the path. Through Crust it becomes `Mantle source or playback failed`.
The control video also produces ten encoded frames through the real Crust Mantle adapter, so this
is not simply an unbuilt or fake media backend. Real `ytmsearch:` and `ytsearch:` requests work.

Revisions are recorded in `evidence/revisions.json` in `/home/rayan/Documents/Projects/raydio-rust`:

- Mantle: `51722267162ba7eae478a9c0601209fc676b2085`
- Crust: `5d27b6e64e43fe21fbfc069f3a4be5bac1a766e5`
- Oto: `8d7a0cbd4e74fa796e0e99cd8634901ce1917bd4`
- Original Raydio: `de690b8` (full hash in the evidence file).

Reproduce from the Rust rewrite checkout:

```sh
cargo run --example mantle_load_probe
cargo run --example media_probe
```

The first example uses Mantle directly and prints only client, public video ID, outcome, and elapsed
milliseconds. The second uses `RealMantleAdapter` and verifies ten encoded frames for successful
loads. Both are Rust examples owned by Raydio for this concrete integration check.

Evidence files:

- `evidence/lavalink-load-comparison.json`: same-host frozen reference results.
- `evidence/mantle-load-comparison.json`: direct Mantle, default and individual clients.
- `evidence/crust-media-probe.json`: real Crust/Mantle frame and load outcomes.
- `evidence/crust-load-probe.json`: successful searches and control video metadata.

## Relevant code and required outcome

Start with `crates/mantle-media/src/youtube.rs`:

- `load_video` / `load_video_with_client` and `player_request`;
- `parse_player_response` and current client profiles/fallback policy;
- `SourceManager::load_with_cancellation`, which currently erases the precise YouTube error into
  `SourceRegistryError::SourceFailure`.

Determine which client request or parsing condition rejects these currently loadable public videos.
Fix that behavior in Mantle while retaining cancellation, response bounds, SSRF policy, and credential
redaction. Add deterministic regression fixtures/tests for the actual cause, and verify live again
with default settings against the same Lavalink/youtube-source configuration. Do not special-case
these video IDs or implement a source fallback in Raydio.

Acceptance for resuming the rewrite:

1. All three direct URLs load as tracks with Mantle's supported default policy.
2. Real `ytmsearch:` and `ytsearch:` remain functional.
3. Supported loaded videos produce encoded Opus through the existing Crust adapter.
4. Regression tests pass and the supported Mantle revision is communicated back.

If diagnosis proves a separate required Crust adapter change, describe the smallest public API change
and its evidence so it can be handed to Crust's Codex. Crust and Oto currently have no independently
proven blocker here.

## Local compiler setup

The host lacks a system C++ driver. Mantle's cached complete `xaac-root` toolchain works; the
`gcc-cxx-root` cache alone lacks required link files. T3 Code's inherited `APPIMAGE`/`APPDIR` variables
also affect tool subprocesses. Only clear them in the build process, never in the running application.
Use a normal installed C/C++ toolchain on other hosts. For this host, see the exact build invocation
in the rewrite's README. No sibling project source was modified during diagnosis.
