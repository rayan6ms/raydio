<p align="center">
  <img src="icons/raydio.png" width="160" height="160" alt="Raydio logo">
</p>

# Raydio

Raydio is a self-hosted, YouTube-first Discord music bot for personal servers. It uses a literal
`\` prefix, discord.js, Shoukaku, and a private Lavalink 4 service with youtube-source.

The deployment is intentionally small: one stateless bot container and one Lavalink container.
Queues live in memory, so a bot restart—or a Lavalink restart that cannot resume its session—clears
them.

## Quick start

You need a private Discord application, a Linux amd64/arm64 host, Docker Engine with Compose, and
outbound HTTPS/DNS access.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
   Under **General Information**, upload `icons/raydio.png` as the application icon. Upload it under
   **Bot** too if you want the bot avatar to match.
2. Under **Bot**, create the bot user, copy its token, and enable only **Message Content Intent**.
3. Under **Installation**, enable **Guild Install**, disable **User Install**, choose the `bot` scope,
   and request only:

   - View Channels
   - Send Messages
   - Connect
   - Speak

   Do not grant Administrator. Raydio has no slash commands.
   Use regular server text channels; forum posts and threads are outside the supported setup.
4. Open the generated install link and add the bot to your private server.

Create the ignored secrets file:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Put the bot token in `DISCORD_TOKEN` and the generated value in `LAVALINK_PASSWORD`. Keep both as
plain, one-line values. Then start the stack:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 bot lavalink
```

Lavalink may need extra time on its first start to download youtube-source. Stop with
`docker compose down`. For Oracle Cloud deployment, updates, rollback, secret rotation, monitoring,
and troubleshooting, see [OPERATIONS.md](OPERATIONS.md).

## Commands

Commands are case-insensitive. Searches prefer YouTube Music and fall back to YouTube; direct URLs
are limited to recognized YouTube video, Music, and playlist forms.

| Command | Aliases | Behavior |
|---|---|---|
| `\play <song or YouTube URL>` | `\p` | Join, resolve, enqueue, and play when idle |
| `\pause` | — | Pause the current track |
| `\resume` | — | Resume the current track |
| `\skip` | `\s` | Skip the current track |
| `\stop` | — | Stop, clear the queue, and remain until the idle timeout |
| `\queue` | `\q` | Show and navigate the queue |
| `\nowplaying` | `\np` | Show current playback details |
| `\volume [0-100]` | `\vol` | Show or set volume |
| `\loop <off\|track\|queue>` | — | Set loop mode |
| `\shuffle` | — | Shuffle upcoming tracks |
| `\remove <index>` | — | Remove an upcoming track by its displayed index |
| `\clear` | — | Clear upcoming tracks |
| `\leave` | `\disconnect`, `\dc` | Disconnect and clear session state |
| `\help` | — | Show the command list |
| `\ping` | — | Show Discord latency and Lavalink readiness |

Playback-changing controls require the caller to share the bot's normal voice channel. Stage
channels are unsupported. Read-only commands and cleanup remain available during a Lavalink outage;
commands that need Lavalink fail fast.

## Configuration reference

Compose supplies the networking values and forwards tuning values from `.env`. Booleans must be
exactly `true` or `false`; numeric bounds use decimal integers.

| Variable | Default | Constraint and purpose |
|---|---:|---|
| `DISCORD_TOKEN` | required | Discord bot token; never log or commit it |
| `LAVALINK_PASSWORD` | required | Random bot-to-Lavalink shared secret |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `LAVALINK_HOST` | `lavalink` | Lavalink host; Compose fixes it to `lavalink` |
| `LAVALINK_PORT` | `2333` | Integer from 1 through 65535; Compose fixes it to 2333 |
| `LAVALINK_SECURE` | `false` | Use TLS for an externally managed Lavalink node |
| `DEFAULT_VOLUME` | `70` | Integer from 0 through 100 |
| `IDLE_DISCONNECT_SECONDS` | `120` | Positive seconds with an empty queue before leaving |
| `ALONE_DISCONNECT_SECONDS` | `120` | Positive seconds without a human listener before leaving |
| `MAX_PLAYLIST_TRACKS` | `250` | Positive accepted-track cap per playlist |
| `MAX_QUEUE_TRACKS` | `1000` | Positive current-plus-upcoming cap per server |
| `MAX_PENDING_PLAY_REQUESTS` | `10` | Positive unresolved-play cap per server |
| `MAX_TRACK_DURATION_HOURS` | `3` | Positive accepted-track duration ceiling |
| `ALLOW_LIVESTREAMS` | `false` | Whether livestream tracks are accepted |

The command prefix is fixed in v1.

## Development

Local tooling is pinned to Node 24.19.0, npm 11.17.0, and TypeScript 7.0.2. Install from the
lockfile and run every static check, test, and build:

```sh
npm ci
npm run check
```

`npm run dev` watches TypeScript source, `npm run build` creates `dist/`, and `npm start` runs that
build. The development and start scripts load an existing `.env`; shell variables take precedence.
The complete two-service stack is supported through Compose.

## Boundaries and recovery

Raydio has no database, persistence, autoplay, Spotify/SoundCloud or arbitrary-HTTP playback,
dashboard, metrics endpoint, multi-node failover, horizontal scaling, Stage support, or supported
forum/thread command surface. It is built for personal/private servers, not public multi-tenant use.

Idle or listener-empty sessions disconnect on their configured timers. Manual bot moves clear that
server's state. Brief Lavalink WebSocket interruptions can resume for up to 60 seconds; a Lavalink
restart or exhausted reconnect window clears affected queues. YouTube behavior remains dependent on
upstream availability.

Never commit `.env` or include it, resolved container environments, authorization headers, or tokens
in logs and reports. Lavalink port 2333 stays private to the Compose network. Rotate a Discord token
immediately if a real token is exposed.

## License

Raydio is available under the [MIT License](LICENSE).
