<p align="center">
  <img src="icons/raydio.png" width="160" height="160" alt="Raydio logo">
</p>

# Raydio

Raydio is a self-hosted, YouTube-first Discord music bot for personal servers. It uses native slash
commands, discord.js, Shoukaku, and a private Lavalink 4 service with youtube-source.

The deployment is intentionally small: one stateless bot container and one Lavalink container.
Queues live in memory, so a bot restart—or a Lavalink restart that cannot resume its session—clears
them.

## Quick start

You need a private Discord application, a Linux amd64/arm64 host, Docker Engine with Compose, and
outbound HTTPS/DNS access.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
   Under **General Information**, upload `icons/raydio.png` as the application icon. Upload it under
   **Bot** too if you want the bot avatar to match.
2. Under **Bot**, create the bot user and copy its token. Raydio requires no privileged Gateway
   intents.
3. Under **Installation**, enable **Guild Install**, disable **User Install**, choose the `bot` and
   `applications.commands` scopes, and request only:

   - View Channels
   - Send Messages
   - Connect
   - Speak

   Do not grant Administrator. Raydio synchronizes its native slash commands when it starts.
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

Typing `/play` provides native song suggestions from YouTube Music, falling back to YouTube. A
manually entered title plays its best match; recognized YouTube video, Music, and playlist URLs are
resolved directly.

| Command | Behavior |
|---|---|
| `/play song:` | Search, join, enqueue, and play when idle |
| `/nowplaying` | Show the artwork, progress, and player controls |
| `/queue` | Show and navigate the queue |
| `/pause` | Pause the current song |
| `/resume` | Resume the current song |
| `/previous` | Return to the most recent prior song in this session |
| `/skip` | Skip to the next song |
| `/stop` | Stop, clear the queue, and remain until the idle timeout |
| `/move from: to:` | Move an upcoming song between displayed queue positions |
| `/jump position:` | Immediately play one upcoming song without discarding the others |
| `/shuffle` | Shuffle upcoming songs |
| `/remove position:` | Remove an upcoming song by its displayed position |
| `/clear` | Clear upcoming songs |
| `/volume [level:]` | Show or set volume from 0 to 100 |
| `/loop mode:` | Set loop mode using Discord's choices |
| `/leave` | Disconnect and clear session state |
| `/help` | Show the command list |
| `/ping` | Show Discord latency and Lavalink readiness |

The modern player offers Previous, Pause/Resume, Next, Stop, Queue, Loop, and Leave buttons, a
YouTube thumbnail, and a progress display refreshed every five seconds. Player controls become
harmless when their playback session is stale.
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
