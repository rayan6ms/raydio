# Oracle home-egress tunnel

The local machine can provide a temporary YouTube egress for the Oracle VM
without exposing an inbound port at home. A user-level SSH service on the
local machine uses OpenSSH remote dynamic forwarding:

```text
local machine -- outbound SSH --> Oracle 163.176.89.211:22
Oracle 127.0.0.1:18080 (SOCKS5) --> local machine --> home internet
```

The local service is `raydio-youtube-tunnel.service` and the Oracle listener
is loopback-only. It uses keepalives and restarts after a broken Starlink or
SSH connection. The local user must have `linger` enabled for it to survive a
logout.

Raydio can use the listener with this environment entry:

```dotenv
RAYDIO_YOUTUBE_PROXY=socks5://127.0.0.1:18080
```

This setting affects Mantle's YouTube HTTP and media requests only. Discord
gateway, REST, voice UDP, and Crust remain direct from Oracle.

## Qualification result

On 2026-09-28 the tunnel returned successful YouTube HTTP requests and exposed
the home egress address. Both SOCKS5 and HTTPS CONNECT transport tests reached
YouTube. Mantle search and Rickroll metadata succeeded, but the Chop Suey
player request still returned `Mantle source or playback failed` through the
home egress. Therefore the tunnel is operational, but it is not by itself a
solution to YouTube's player/session challenge.

Raydio's proxy entry is currently disabled so production playback does not
depend on a Starlink/SSH tunnel that has not passed the target-video test. The
local tunnel service remains available for a subsequent test with a valid
YouTube session generated through the same home egress. Do not enable it for a
long run until direct, search, and playlist playback all pass from Oracle.

Do not put proxy credentials, cookies, OAuth tokens, PoTokens, or signed URLs
in this document or in repository history.
