# Raydio operations on Oracle Cloud

This runbook deploys Raydio as one non-root bot container plus one private Lavalink container on an
Oracle Cloud Infrastructure (OCI) Compute VM. It assumes Docker Engine and the Compose plugin; no
application port is exposed to the internet.

## Deployment boundary

The reproducible path is an OCI VM using a current Ubuntu 24.04 LTS platform image. Both pinned base
images publish linux/amd64 and linux/arm64/v8 manifests, so either an AMD/Intel shape or an Ampere A1
shape can run the stack. Start with resources appropriate for a personal Java audio service—for
example 1–2 OCPUs and 4–6 GiB RAM—and adjust only after observing real CPU and memory use.

Oracle Linux can also run the images, but host Docker/Compose installation and support are an
operator responsibility; this repository's validated instructions follow Docker's Ubuntu path.

OCI's [instance documentation](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm)
covers image, shape, VCN, public/private IP, and SSH-key selection. For Ampere platform images, let
OCI choose the recommended networking mode. Oracle's
[Compute security guidance](https://docs.oracle.com/en-us/iaas/Content/Security/Reference/compute_security.htm)
recommends key-only SSH and network plus host firewall controls.

## Network posture

- Allow inbound TCP 22 only from the administrator's trusted source CIDR, or use OCI Bastion.
- Do not add ingress rules for 2333 or any bot/application port. Compose publishes none.
- Allow normal outbound DNS and HTTPS so the host can reach registries and the containers can reach
  Discord, YouTube, and the Lavalink plugin repository.
- Keep SSH password and root login disabled. Keep the host firewall aligned with the OCI network
  security group or security list.

## Host preparation

Install Docker Engine, Buildx, and the Compose plugin using Docker's current
[Ubuntu installation instructions](https://docs.docker.com/engine/install/ubuntu/). Do not use an
unmaintained standalone `docker-compose` binary. Verify the installed service and plugin:

```sh
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

The safest baseline is to keep using `sudo docker`. If you deliberately add an operator to the
`docker` group, understand that Docker's
[Linux post-install documentation](https://docs.docker.com/engine/install/linux-postinstall/)
describes that group as root-equivalent access.

Install Git, clone the repository into an operator-owned directory, and enter it:

```sh
sudo apt-get update
sudo apt-get install --yes git openssl
git clone <repository-url> raydio
cd raydio
```

## Secrets and first start

Create the ignored environment file and restrict it:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Edit `.env` and set:

- `DISCORD_TOKEN` to the bot token from the Discord Developer Portal;
- `LAVALINK_PASSWORD` to the generated random value;
- optional tuning variables only when the documented defaults are unsuitable.

Store recoverable copies of both secrets in a password manager. Do not put them in shell history,
cloud-init user data, tickets, chat, images, repository files, or copied Compose output.

Validate without printing resolved configuration, then start:

```sh
sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail 100 bot lavalink
```

Expected state:

- Lavalink becomes healthy after Java and youtube-source initialize;
- the bot starts afterward and logs `discord_ready`;
- neither service has a host-published port;
- `\ping` reports Discord latency and Lavalink ready.

The exact base images support both target architectures, but perform the first-deployment checks on
the selected VM; this repository's build validation ran on amd64 only.

## Routine operation

```sh
sudo docker compose ps
sudo docker compose logs --tail 200 bot
sudo docker compose logs --tail 200 lavalink
sudo docker stats --no-stream
sudo docker system df
df -h
```

Follow current logs only while diagnosing:

```sh
sudo docker compose logs --follow --tail 100 bot lavalink
```

The application logs structured events to standard output. It redacts known token/password fields,
but still review collected logs before sharing them. Never share `.env`, `docker inspect` environment
output, authorization headers, guild/user identifiers that should remain private, or raw upstream
payloads.

Both services use `restart: unless-stopped`. With Docker enabled at boot, they return after a VM
reboot unless an operator explicitly stopped them. Verify with `docker compose ps` after maintenance.

## Clean stop and restart

```sh
sudo docker compose down
sudo docker compose up -d
sudo docker compose restart bot
```

Prefer `down` for a controlled full-stack stop. The bot receives SIGTERM directly and has a
15-second Compose grace period around its internal ten-second shutdown deadline.

Queue state is ephemeral. Restarting the bot clears all queues. A short Lavalink WebSocket outage
may resume transparently, but a Lavalink process restart clears affected queues because its prior
server session no longer exists.

## Updating

Before updating, confirm the working tree contains only intended operator changes and record the
known-good revision:

```sh
git status --short
git rev-parse HEAD
git fetch --all --tags --prune
git pull --ff-only
sudo docker compose build --pull bot
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail 100 bot lavalink
```

Image digests and npm versions are repository-controlled. Review dependency/image changes before
deploying them; do not replace pinned images with floating `latest` tags.

Run the repository gate when Node/npm are installed on the host or in CI:

```sh
npm ci
npm audit
npm run check
```

## Rollback

Use the previously recorded revision. A detached checkout is suitable for a deployment directory:

```sh
git fetch --all --tags --prune
git switch --detach <known-good-commit>
sudo docker compose build bot
sudo docker compose up -d
sudo docker compose ps
```

Return to the tracked deployment branch explicitly before the next normal update. Rollback restores
code/configuration, not queues: v1 has no persisted application state.

## Secret rotation

If the Discord token is exposed, reset it immediately in the Developer Portal, update
`DISCORD_TOKEN`, and recreate only the bot:

```sh
chmod 600 .env
sudo docker compose up -d --force-recreate bot
```

To rotate the Lavalink password, generate a new random value, update `LAVALINK_PASSWORD`, and
recreate both services together:

```sh
openssl rand -hex 32
sudo docker compose up -d --force-recreate lavalink bot
```

The controlled Lavalink restart ends any session that cannot server-resume; users must `\play`
again.

## Backup policy

Raydio has no database or application data volume. There is no queue/history backup to take. The
durable material is:

- the repository revision and its pinned lockfiles/images;
- the externally stored Discord token and Lavalink password;
- intentional `.env` tuning values;
- any operator-owned infrastructure configuration.

Keep secrets in a password manager rather than an ordinary backup archive. Rebuilding from a known
revision plus restored secrets is the recovery procedure.

## Container scanning and host maintenance

This repository does not bundle a scanner. On a host with Trivy, scan both deployed images:

```sh
trivy image --severity HIGH,CRITICAL raydio-bot:0.1.0
trivy image --severity HIGH,CRITICAL ghcr.io/lavalink-devs/lavalink:4.2.2-alpine@sha256:96be2be7ee50d35a9bd42c8c7b99e2a4b741f09123066c1ebb9e014dd7db204d
```

Investigate findings in the context of reachable runtime behavior. Update exact patch versions and
digests deliberately; do not suppress findings by floating tags. Keep the OCI host, Docker Engine,
and Compose plugin patched according to their vendor guidance.

## First-deployment acceptance

Automated tests and local image checks cannot prove Discord DAVE/audio acceptance. Before treating a
new host as production-ready, use a private voice/text channel and verify:

1. `\help` and `\ping` work without mentioning users or roles.
2. Text search, direct YouTube URL, and a small playlist produce audible playback.
3. Queue advance, pause/resume, volume, skip, stop, loops, shuffle/remove/clear, and leave work.
4. Same-channel authorization and Stage rejection work.
5. Idle and alone timers disconnect; a manual bot move/disconnect cleans state.
6. An unavailable item does not crash the queue; repeated failures trigger the guard.
7. A controlled Lavalink restart leaves the bot process alive and either resumes or reports cleanup.
8. `docker compose stop bot` exits within the configured grace period.
9. During a 30–60 minute playback smoke test, CPU/RSS stabilize and no duplicate advancement or
   reconnect loop appears.

Record failures by category and change one source/client/configuration variable at a time. YouTube
and Discord behavior can change independently of a healthy local container.

## Troubleshooting quick reference

- **Compose rejects configuration:** both required secrets must be non-empty; use
  `docker compose config --quiet`, not secret-printing output.
- **Lavalink stays unhealthy:** check plugin repository/YouTube egress, DNS, memory, and Lavalink
  logs. Cold plugin download can take time.
- **Bot repeatedly restarts:** inspect the first configuration/login error. Confirm Message Content
  Intent and reset invalid tokens.
- **Bot cannot connect to Lavalink:** both services must be on the `raydio` network and use the same
  `LAVALINK_PASSWORD`; the bot host is `lavalink`, not `localhost`.
- **Disk use grows:** inspect `docker system df`; remove obsolete images deliberately only after a
  known-good rollback target is available.
- **SSH fails:** verify the OCI public/private access path, TCP 22 source rule, username, and SSH key;
  see Oracle's [SSH troubleshooting guide](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/troubleshooting-ssh-connection.htm).
