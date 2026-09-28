# YouTube source proxy

Raydio/Mantle supports an optional HTTP, HTTPS CONNECT, or SOCKS4/4A/5 proxy
for source control and media traffic:

```dotenv
RAYDIO_YOUTUBE_PROXY=socks5://user:password@proxy.example:1080
```

The value is read only by Mantle's source HTTP agents. It is never logged,
included in diagnostics, or committed. Discord gateway, REST, voice, and local
Crust traffic use their existing direct clients.

The same proxy setting is used for YouTube search, player discovery, watch-page
fallback, signature-related requests, and signed media range requests. This is
required because routing only metadata through a proxy would still expose the
Oracle address during media handoff.

The setting is optional and unset in production. A proxy endpoint must be tested
from the Oracle VM with a representative search, direct video, and playlist;
shared free VPN/proxy endpoints are commonly challenged or rate limited.
