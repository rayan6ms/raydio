# Optional YouTube authentication

Raydio accepts credentials through the deployment environment. They are intentionally not stored in the repository or emitted in diagnostics:

- `RAYDIO_YOUTUBE_OAUTH_ACCESS_TOKEN` or `RAYDIO_YOUTUBE_OAUTH_REFRESH_TOKEN`
- `RAYDIO_YOUTUBE_PO_TOKEN` together with `RAYDIO_YOUTUBE_VISITOR_DATA`
- `RAYDIO_YOUTUBE_COOKIES` as a browser `Cookie` header value

OAuth and proof-of-origin are alternatives. Do not combine unrelated values from different browser sessions.

## OAuth

The Lavalink YouTube source documents an official device OAuth flow. Enable OAuth in a temporary Lavalink/youtube-source instance, follow the verification URL and code printed by the source, and save the resulting refresh token. A refresh token is preferable to an access token because the source can refresh access tokens without frequent redeployment. Use a separate low-value YouTube account; the upstream documentation warns that OAuth automation can trigger rate limits or account action.

For Raydio, place the resulting refresh token in `/etc/raydio/env` as `RAYDIO_YOUTUBE_OAUTH_REFRESH_TOKEN=...`, readable only by root and the `raydio` service, then restart the service. The embedded Mantle client uses the OAuth-capable TV profile when obtaining playback formats.

## Proof-of-origin

The older [youtube-trusted-session-generator](https://github.com/iv-org/youtube-trusted-session-generator) repository is now marked deprecated and may no longer produce tokens accepted by YouTube. Prefer the current [Invidious Companion](https://github.com/iv-org/invidious-companion) workflow or another actively maintained generator. Run it on the same public egress IP as Oracle, keep the returned `poToken` and matching `visitorData` together, and install them as `RAYDIO_YOUTUBE_PO_TOKEN` and `RAYDIO_YOUTUBE_VISITOR_DATA` in the Oracle secret file. Restart Raydio after changing them.

Tokens are tied to the generating session and may expire or be rejected after YouTube changes its checks. Treat both values as secrets and never paste them into chat, a ticket, or the repository.

## Cookies

Cookies are a fallback for an account-backed browser session. Export only the YouTube cookies needed by the source using a trusted local browser tool, keep the complete `name=value; name=value` header in a root-owned secret file, and never paste it into chat, commit it, or include it in a bug report. Cookies expire and may invalidate the account session; OAuth or a proof-of-origin pair is preferred.

Authentication is not a guarantee: YouTube can still rate-limit an account or egress address. If a credential is rejected, remove it and return to the unauthenticated client fallback.
