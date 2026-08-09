<p align="center">
  <img src="icons/raydio.png" width="160" height="160" alt="Raydio logo">
</p>

# Raydio

Raydio is a self-hosted, YouTube-first Discord music bot for personal/private servers. It uses a
literal `\` command prefix, discord.js for the Discord gateway, Shoukaku for the client boundary,
and a separate Lavalink 4 service with youtube-source for media resolution and Discord voice
transport.

The v1 deployment is intentionally small: one stateless bot container and one private Lavalink
container. There is no database, dashboard, slash-command surface, Spotify integration, or public
service port. Queue state is held in memory and is not preserved across bot restarts or a Lavalink
restart that cannot resume its prior session.

## Requirements

For the recommended container deployment:

- a Linux amd64 or arm64 host;
- Docker Engine with the Docker Compose plugin;
- outbound HTTPS/DNS access for Discord, YouTube, image pulls, and the youtube-source plugin;
- a private Discord application and server where you can install its bot user.

The bot image pins Node 24.18.0 Bookworm slim by multi-architecture digest. Lavalink is pinned to
4.2.2 Alpine by multi-architecture digest. Lavalink port 2333 is exposed only to the private Compose
network, never to the host.

## Discord application setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
   Under **General Information**, upload `icons/raydio.png` as the application icon. Discord keeps
   application and bot-user avatars separate, so use the same image under **Bot** if you want both
   identities to match.
2. Open **Bot**. Create the bot user if Discord has not already created it, then reset/copy its token.
   Treat the token as a password; it belongs only in the ignored local `.env` file or a secret
   manager.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**. Leave **Server Members
   Intent** and **Presence Intent** disabled. Discord requires privileged intents to be enabled in
   the portal before a client requests them; unverified private apps do not need separate approval.
   See Discord's [Gateway intent documentation](https://docs.discord.com/developers/events/gateway#privileged-intents).
4. Open **Installation**. Enable **Guild Install**, disable **User Install**, and select a
   Discord-provided install link. Raydio ignores direct messages and has no user-install surface.
5. Under the Guild Install defaults, add only the `bot` scope. Raydio has no slash commands, so it
   does not need `applications.commands`.
6. Request only these bot permissions:

   - View Channels
   - Send Messages
   - Connect
   - Speak

   Do not grant Administrator. Channel-specific permission overwrites must also allow these actions.
   Discord documents the bot scope and least-privilege model in
   [OAuth2 and Permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions).
7. Open the generated install link and add the bot to a private test server.

Raydio requests only the `Guilds`, `GuildMessages`, `GuildVoiceStates`, and `MessageContent` gateway
intents. It ignores direct messages and messages authored by bots.

## Configure and start

Copy the example environment and protect it before adding secrets:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Put the Discord bot token in `DISCORD_TOKEN` and the generated random value in
`LAVALINK_PASSWORD`. Use plain one-line values and do not add inline comments to secret lines.
Never commit `.env` or paste its contents into logs, issues, or chat.

Validate the Compose model without printing its resolved secret-bearing configuration, then build
and start both services:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 bot lavalink
```

The first Lavalink start may take longer while it downloads the pinned youtube-source plugin. The
bot waits for Lavalink's authenticated healthcheck in Compose and also handles later Lavalink
outages in-process.

Stop cleanly with:

```sh
docker compose down
```

For Oracle Cloud deployment, updates, rollback, rotation, monitoring, and first-deployment
acceptance, see [OPERATIONS.md](OPERATIONS.md).

## Commands

Commands are case-insensitive and use one literal backslash. Ordinary text search prefers YouTube
Music and falls back to YouTube. Direct URLs are restricted to recognized YouTube video, Music, and
playlist shapes.

| Command | Aliases | Behavior |
|---|---|---|
| `\play <song or YouTube URL>` | `\p` | Join if needed, resolve, enqueue, and start when idle |
| `\pause` | — | Pause the current track |
| `\resume` | — | Resume the current track |
| `\skip` | `\s` | Skip exactly one current track |
| `\stop` | — | Stop and clear the queue; remain connected until the idle timeout |
| `\queue` | `\q` | Show current playback and navigate stable upcoming-track pages |
| `\nowplaying` | `\np` | Show current track, requester, progress, loop, and volume |
| `\volume [0-100]` | `\vol` | Show the current volume or set it |
| `\loop <off\|track\|queue>` | — | Set loop mode |
| `\shuffle` | — | Shuffle upcoming tracks only |
| `\remove <index>` | — | Remove one upcoming track using the index shown by `\queue` |
| `\clear` | — | Clear upcoming tracks without stopping the current track |
| `\leave` | `\disconnect`, `\dc` | Destroy the session, clear state, and disconnect |
| `\help` | — | Show the command list |
| `\ping` | — | Show Discord latency and Lavalink readiness |

Playback-changing controls require the caller to be in the bot's active normal voice channel.
Stage channels are not supported. `\help`, `\ping`, `\queue`, `\nowplaying`, and a `\volume` query
without a value can be used outside voice. Read-only views and local cleanup remain available
during a Lavalink outage, while commands requiring remote work fail fast.

Queue pages show current progress, finite remaining queue time, requester details, and ten upcoming
tracks at a time. Previous/Next buttons are bound to the current player session; controls from an
older or ended session are retired without affecting a replacement queue.

## Configuration reference

Compose supplies the networking values shown below and forwards every tuning value from `.env`.
Booleans must be exactly `true` or `false`; numeric bounds must be decimal integers.

| Variable | Default | Constraint and purpose |
|---|---:|---|
| `DISCORD_TOKEN` | required | Discord bot token; never log or commit it |
| `LAVALINK_PASSWORD` | required | Random shared secret used only between bot and Lavalink |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `LAVALINK_HOST` | `lavalink` | Lavalink hostname; Compose intentionally fixes this to `lavalink` |
| `LAVALINK_PORT` | `2333` | Integer from 1 through 65535; Compose fixes this to 2333 |
| `LAVALINK_SECURE` | `false` | Use TLS when connecting to an externally managed Lavalink node |
| `DEFAULT_VOLUME` | `70` | Integer from 0 through 100 |
| `IDLE_DISCONNECT_SECONDS` | `120` | Positive seconds after an empty queue before leaving |
| `ALONE_DISCONNECT_SECONDS` | `120` | Positive seconds with no non-bot listener before leaving |
| `MAX_PLAYLIST_TRACKS` | `250` | Positive application cap per resolved playlist |
| `MAX_QUEUE_TRACKS` | `1000` | Positive total current-plus-upcoming cap per server |
| `MAX_PENDING_PLAY_REQUESTS` | `10` | Positive per-server cap on ordered unresolved play work |
| `MAX_TRACK_DURATION_HOURS` | `3` | Positive duration ceiling for accepted tracks |
| `ALLOW_LIVESTREAMS` | `false` | Whether livestream tracks are accepted |

The command prefix is not configurable in v1.

## Local development

Local tooling requires Node 24.18.0 and npm 11. Install exactly from the lockfile:

```sh
npm ci
npm run check
```

Useful commands:

```sh
npm run dev       # watch the TypeScript process; requires a reachable Lavalink and valid .env
npm run build     # clean production JavaScript build in dist/
npm start         # run the built process
npm test          # deterministic node:test suite
npm run typecheck
npm run lint
npm run format
```

The production Compose deployment is the supported way to run the complete two-service stack.

## Recovery and persistence

- Idle and listener-empty sessions disconnect after their configured timers.
- A manual bot move or disconnect clears that server's session instead of silently adopting the new
  channel.
- A short Lavalink WebSocket interruption can preserve playback when Lavalink confirms the old
  server session resumed within 60 seconds.
- A Lavalink process restart or exhausted reconnect window clears affected in-memory queues and asks
  users to start again.
- A bot process/container restart clears all queues. There is no database or queue backup in v1.

## Troubleshooting

- **Bot is offline:** inspect `docker compose ps` and `docker compose logs --tail 200 bot`. Missing or
  malformed environment variables fail startup with the variable name but not its value.
- **Bot is online but ignores commands:** enable Message Content Intent and verify it can View the
  text channel and Send Messages there.
- **Cannot join or speak:** verify View Channels, Connect, and Speak on the exact voice channel;
  confirm the channel is not full and is not a Stage channel.
- **Music service is temporarily unavailable:** inspect Lavalink health/logs and outbound network
  access. Plugin download or YouTube availability can delay readiness.
- **Control is rejected:** join the same normal voice channel as the active bot session.
- **Playlist or track is rejected:** check configured queue, playlist, duration, and livestream
  bounds. Arbitrary non-YouTube URLs are intentionally unsupported.

When collecting logs, never include `.env`, Docker inspection output containing environment values,
authorization headers, or bot tokens. Rotate a Discord token immediately if it is exposed.

## v1 limitations

Raydio is intended for personal/private servers. It has no slash commands, persistence, autoplay,
Spotify/SoundCloud playback, arbitrary HTTP playback, Stage support, dashboard, metrics endpoint,
multi-node failover, or horizontal scaling. YouTube behavior depends on upstream availability and
may require future youtube-source/client updates.

## License

Raydio is available under the [MIT License](LICENSE).
