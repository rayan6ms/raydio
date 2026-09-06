# Oracle Cloud deployment

Use **Ubuntu 24.04** on `VM.Standard.A1.Flex` (Ampere ARM64) or an x86-64 shape.
Start with one OCPU and 1 GiB RAM for a small bot; the
provided service caps the bot at 256 MiB. Raise limits deliberately for many guilds.
The binary is built natively for each architecture on Debian 12 (glibc 2.36),
and includes the media codecs. Runtime dependencies are libc, libgcc, libm, and
the OS CA certificate bundle. No JVM, Node, ffmpeg, or Rust compiler is needed.
Use Ubuntu 24.04 for the validated deployment path. The examined artifacts need
glibc symbols through 2.34, but other distributions have not received the same
installation and runtime validation.

## Network and Discord

- Give the instance outbound internet access through a public subnet/internet
  gateway or NAT. Permit DNS, HTTPS/WSS (TCP 443), and outbound UDP plus stateful
  reply traffic for Discord voice. No inbound bot port is required.
- Restrict SSH to your administrative IP. Keep the instance clock synchronized.
- Invite the bot with `bot` and `applications.commands`; permit View Channel,
  Connect, Speak, Send Messages, Embed Links, and Read Message History where used.
  The runtime requests Guilds and Guild Voice States; no privileged intent is required.
- Put only the **production** token in `/etc/raydio/env` as `DISCORD_TOKEN=...`.
  Never commit this file or pass the token on a command line. Testbot is separate.

The active deployment uses one Always Free `VM.Standard.E2.1.Micro` instance
with 1 GiB RAM, Ubuntu 24.04 x86-64, and a 47 GiB boot volume in São Paulo.
Reuse this instance. The personal local Terraform bundle now matches the Micro launch configuration.
The old capacity-retry script targets A1 and is obsolete for this deployment;
application updates use `raydioctl` and need no infrastructure apply. Tenancy, SSH keys, and stack identifiers are not published.

## First install

Download the release archive and matching checksum from
[GitHub Releases](https://github.com/rayan6ms/raydio/releases). Choose `aarch64`
for Ampere A1 or `x86_64` for Intel/AMD.

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl
sha256sum --check raydio-linux-aarch64.tar.gz.sha256
mkdir raydio-package
tar -xzf raydio-linux-aarch64.tar.gz -C raydio-package
sudo bash raydio-package/deploy/raydioctl install "$PWD/raydio-linux-aarch64.tar.gz"
sudoedit /etc/raydio/env
sudo raydioctl start
sudo raydioctl status
```

`start` enables boot startup and waits for Discord readiness (up to 90 seconds).
The service runs as the unprivileged `raydio` user. Crust listens only on an
ephemeral loopback port and uses a random per-process password.

## Update and rollback

After code changes pass CI, publish a new `vMAJOR.MINOR.PATCH` tag. CI tests and
builds on native ARM64 and x86-64 runners, then publishes small archives and SHA256
checksums. No VM build is needed.

```sh
sudo raydioctl update v0.2.1           # use the release you intend to deploy
sudo raydioctl rollback              # switch to the previous installed release
sudo raydioctl logs
```

An update verifies checksums, executes the offline backend check, then swaps the
`/opt/raydio/current` symlink and restarts the service. If Discord startup fails,
the updater restores the previous release and returns an error. `/etc/raydio/env`
is preserved. A restart disconnects voice and clears the in-memory queue; this is
not a zero-downtime music migration. Old releases are retained for manual removal
after validation. There is no unattended updater or scheduled network poll.

For an unpublished CI artifact, unpack its ZIP and use `raydioctl update` with
the local `.tar.gz` path. Never use the GitHub source ZIP as a binary package.

## Verification and troubleshooting

`raydio --check` checks the real embedded backend without contacting Discord or
YouTube. `raydio --probe-backend` additionally exercises live YouTube loading.
After deployment, join voice and run `/play`; use `/diagnostics` for player and
audio frame health. A successful build cannot guarantee YouTube permits every
Oracle egress IP or video. Verify source access from the actual instance before
depending on it for continuous operation.

Use `journalctl -u raydio -n 100` for startup failures, `systemctl show raydio -p
MemoryCurrent -p MemoryPeak -p TasksCurrent` for resource use, and
`systemctl edit raydio` for local limit overrides. Defaults are two Tokio workers,
bounded queues, 128 MiB MemoryHigh, 256 MiB MemoryMax, 32 tasks, and a 15-second
shutdown deadline. `MemoryHigh` can throttle allocations, so raise it if measured
multi-guild usage approaches that limit.

The service sets `MALLOC_ARENA_MAX=2` before process startup to reduce glibc's
retained allocator memory with two Tokio workers. The same binary measured
15.78 MiB playback PSS with this setting versus 19.75 MiB without it in the
initial comparison. For a manual run, prefix the command with
`MALLOC_ARENA_MAX=2`; putting it in an application-read env file after startup
does not configure glibc. Recheck contention and memory when scaling to many guilds.

The initial capacity report returned `OUT_OF_HOST_CAPACITY` for both free shapes.
An actual Micro launch subsequently succeeded on September 6. The verified
inventory contains exactly one running instance; the capacity report is historical.
Always Free and one instance are deployment constraints: do not add a paid shape
or an additional instance as a workaround.

Process memory must be measured with `/proc/PID/smaps_rollup` (PSS and RSS),
alongside cgroup accounting. `MemoryCurrent` can omit shared file pages charged
to a different cgroup and is not the bot's total memory footprint. The initial
Oracle run used about 12 MiB idle PSS and 15.4 MiB playback PSS, with roughly
4% of one CPU during steady playback. That run suffered a terminal audio failure;
these resource numbers are not evidence of audio reliability.

After deploying `v0.2.1` and removing Testbot, three 15-second authenticated-idle
windows measured **12,683 KiB PSS (12.39 MiB)**, 15,132 KiB RSS, and three threads.
Idle CPU was 0–0.067% of one core at this sampling resolution. The warmed
multi-track Testbot run retained **17.52–17.64 MiB PSS**, at about 4.1–4.4% of one
core in fully active windows. This round improved diagnosis and deployment
conditions; it does not claim an additional idle-memory reduction.

The production Discord application is now running on Oracle from Rust release
`v0.2.1` (revision `7c83076`). The published x86-64 package is 7,427,033 bytes;
ARM64 is 7,043,618 bytes. Native CI passed on both architectures, and the live
`raydioctl update v0.2.1` command passed checksum, backend, and Discord-readiness
checks. A preceding update → rollback → update also passed on this VM and
preserved the production environment file. See
[`release-validation-v0.2.1.json`](../evidence/release-validation-v0.2.1.json).
Discord's developer portal does not host the
TypeScript or Rust program:
deploying Rust with the existing production token preserves the bot identity,
server membership, and permissions. Stop the previous runtime before starting
that identity on the VM.

## Keep administrative measurements from disturbing audio

Ubuntu's SSH PAM session generated a fresh dynamic login message, including
`landscape-sysinfo` and update-status scripts. On the Micro VM, these bursts
coincided with CPU steal and delayed audio. The dynamic `pam_motd.so` entry in
`/etc/pam.d/sshd` now has `noupdate`, so SSH uses the cached status message.
Authentication/account rules were preserved, `sshd -t` passed, and subsequent
SSH logins worked. The prior file is retained on the VM for restoration.

This removed those scripts from the repeated scheduling trace, but did not
eliminate every late audio packet. It is not an audio-quality guarantee. Capture
a quiet playback window without new SSH sessions, builds, or kernel tracing,
then test controls separately. CPU steal is time the guest could not run on the
host; a low average bot CPU percentage does not rule out short scheduling gaps.
See [`ORACLE-RELIABILITY.md`](../evidence/ORACLE-RELIABILITY.md) for receiver evidence
and [`FREE-HOSTING.md`](FREE-HOSTING.md) for the six-hour/day, one-channel budget.
