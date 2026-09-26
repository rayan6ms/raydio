# Oracle YouTube proof-of-origin setup

The maintained route for obtaining YouTube proof-of-origin material is
Invidious Companion. It runs the BotGuard flow from the same public egress as
the bot and refreshes session material itself:

```sh
SERVER_SECRET_KEY=<16 alphanumeric characters> \
JOBS_YOUTUBE_SESSION_PO_TOKEN_ENABLED=true \
deno task dev
```

The companion generates a session token, visitor data, and per-video content
tokens. The old `youtube-trusted-session-generator` is deprecated and should
not be used for a production setup.

I ran the current companion temporarily on Oracle. It generated both session
and per-video token material, but YouTube still returned
`LOGIN_REQUIRED` (“Sign in to confirm you’re not a bot”) for the Chop Suey
player request. The generated values were therefore discarded and were not
installed in Raydio.

For an account-backed fallback, a dedicated burner account must be signed in
from a Chromium/Chrome session whose traffic exits through Oracle. Export the
complete YouTube `Cookie` header from that Oracle session and install it as
`RAYDIO_YOUTUBE_COOKIES` in `/etc/raydio/env`. Validate the cookie from Oracle
against a representative search result before restarting Raydio. Do not mix
cookies, visitor data, or proof tokens from different sessions, and never store
them in the repository or diagnostics.

The practical remaining options are an Oracle egress/IP change or an
Oracle-origin browser cookie session. A token generated from the local machine
cannot be assumed to work for Oracle.
