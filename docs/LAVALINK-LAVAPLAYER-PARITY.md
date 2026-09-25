# Lavalink/LavaPlayer parity for YouTube playback

This document records the feature comparison for the Rust Raydio stack. The comparison is about behavior relevant to a Discord music bot; Lavalink REST/plugin administration features are not part of Raydio's in-process architecture.

## Implemented

| Capability | Raydio implementation |
| --- | --- |
| Ordered InnerTube client fallback | Music, Android VR, Web, Web Embedded, TV, and VisionOS are tried in configured order. Playback falls through when a client is challenged or returns unusable formats. |
| Search, direct video, playlist, and mix loading | Bounded search/playlist pagination and result normalization are implemented. Search uses ordinary YouTube first and Music as a fallback. |
| OAuth playback | Optional access-token and refresh-token authentication is injected into the OAuth-capable TV player client. Refreshes are cached and bounded. |
| Browser/session authentication | Optional cookies are attached only to YouTube control-plane requests. Values are redacted from diagnostics. |
| Proof of origin | Optional `poToken` plus matching `visitorData` is sent to Web/Web Embedded requests. VisionOS can acquire visitor data from a bounded embed response when needed. |
| Player signature and `n` deciphering | Mantle has a bounded native player-script parser/cache and a separate resolver interface for unusual scripts. No JavaScript runtime is required in the bot. |
| HTTP resilience | Control-plane and media range requests use bounded retries, deadlines, cancellation, response limits, and route-aware connection handling. |
| Source isolation | Finite compressed sources can be staged to a bounded private temporary file; repeat playback reuses the staged object. |
| Playback continuity | Crust keeps bounded read-ahead, preserves EOF ordering, skips failed tracks within a bounded failure policy, and stops after repeated failures instead of looping indefinitely. |
| Efficient voice transport | Oto uses absolute pacing deadlines, bounded capacity-one handoff, reusable frame storage, DAVE lifecycle handling, and direct Opus passthrough when filters do not require decoding. |
| Route-planner integration | Crust/Mantle support shared route selection and outcome reporting. Raydio deliberately uses a disabled planner on the single-IP Oracle VM. |

## Deliberately optional or architecture-specific

- **Remote cipher service:** Lavalink can delegate deciphering to a separate HTTP service. Raydio already has a bounded native resolver and an isolated resolver interface; adding a remote service would add another dependency, network hop, secret, and failure mode without helping the current Oracle challenge. It should only be enabled if YouTube changes require a script the native resolver cannot handle.
- **Additional low-value client variants:** Lavalink exposes more experimental clients (for example MWEB, Android Music, iOS, and TVHTML5 variants). They are not enabled because they duplicate existing routes or are frequently restricted. Adding every identifier would increase request volume and challenge surface rather than improve reliability.
- **Lavalink REST/plugin endpoints:** Raydio embeds Crust and Mantle in one process, so source loading and player state are local APIs rather than a second JVM/REST node. This removes a hop and keeps the deployment small.
- **Per-track OAuth userData:** Lavalink accepts an access token in track metadata. Raydio uses one service-level credential from the protected environment, which is the correct isolation model for a single bot identity.

The remaining Oracle failures for searches such as `chop suey` are therefore an upstream YouTube egress challenge, not a missing Lavaplayer feature. Installing a valid OAuth refresh token or a matching proof-of-origin pair can change that outcome; credentials must never be committed or pasted into chat.
