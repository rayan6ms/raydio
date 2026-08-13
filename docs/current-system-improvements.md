# Current-system improvement plan

**Reviewed:** 2026-08-12

**Scope:** improve Raydio's existing behavior, reliability, security, maintainability, and operation
without adding a new product capability

**Status:** diagnostic record and prioritized implementation backlog

## Executive assessment

Raydio's current baseline is healthy for a private, self-hosted bot. Its configuration is validated,
the TypeScript compiler is strict, runtime state is bounded, playback mutations are serialized per
guild, secrets are ignored and redacted, containers run read-only without published ports or Linux
capabilities, dependencies and images are pinned, and the automated release gate passes.

The next pass should focus on the audio service supply chain and live-container compatibility,
followed by higher-fidelity integration testing and decomposition of the two largest orchestration
modules. New user-facing features should wait until the P0 items below are resolved or explicitly
accepted.

## Diagnostic evidence

The review covered the source tree, configuration, Compose and image definitions, Windows scripts,
CI, documentation, test suite, dependency audit, local image scans, and the running containers.

- `npm run check` passed: type checking, lint, 149 tests in 31 suites, and production build.
- `npm audit` reported zero known npm vulnerabilities.
- Node's test coverage reported 86.49% lines, 83.40% branches, and 87.58% functions overall.
- `src/discord.ts` is the principal coverage gap at 60.37% lines and 54.79% branches; it is also
  1,572 lines. `src/music/manager.ts` is 1,681 lines but has 96.37% line coverage.
- The bot image scan reported zero HIGH or CRITICAL vulnerabilities, zero Dockerfile
  misconfigurations, and no detected secrets.
- The pinned Lavalink image scan reported 13 operating-system and 35 Java HIGH/CRITICAL findings:
  44 HIGH and 4 CRITICAL in total. Several have fixed component versions, but reachability must be
  assessed because scanner findings do not by themselves prove exploitability.
- The running bot was ready, synchronized all 19 commands, used about 44 MiB at rest, and had no
  restarts or warning/error logs during this pass.
- Lavalink was healthy at about 204 MiB, but had restarted once after a transient DNS failure while
  downloading the YouTube plugin. It also emits a `StatsCollector` error every minute because OSHI
  cannot read a host `/sys/devices/system/cpu/*/thermal_throttle` path from the rootless container.
- The bot container has no healthcheck; Compose and the Windows readiness script infer health from
  process state plus recent startup logs.
- CI validates Linux code and parses PowerShell, but it does not build both image architectures,
  start the Compose stack, execute Windows manager behavior, scan images, or test a real Discord ↔
  Lavalink voice session.

The diagnostic is a point-in-time assessment. Vulnerability databases and upstream YouTube/Discord
behavior change; rerun the scans and acceptance tests at each dependency or image update.

## Priority definitions

- **P0:** address before feature expansion because it affects security confidence or signal quality.
- **P1:** high-value reliability or maintainability work for the next engineering pass.
- **P2:** useful hardening or polish after P0/P1 work.
- **P3:** conditional work that should happen only when deployment scale or evidence justifies it.

## P0 — security and operational signal

### 1. Assess and remediate the Lavalink image findings

**Why now:** the application image is clean at HIGH/CRITICAL severity, while the pinned Lavalink
image contains fixed upstream findings in Alpine/OpenSSL/musl/zlib and bundled Java libraries.
Private networking and authentication reduce exposure but are compensating controls, not fixes.

**Work:**

1. Export a machine-readable scan report and classify each finding as reachable, mitigated by the
   configuration, or not applicable to Raydio's enabled endpoints and sources.
2. Check for a refreshed official 4.2.2 image digest or the next stable release that upgrades the
   affected components. Never replace the digest with a floating tag.
3. Stage the candidate with DAVE, direct video, playlist, search, reconnect, and natural-end tests.
4. If upstream has no acceptable fixed stable artifact, evaluate a reproducible custom Lavalink
   image built from a reviewed upstream commit. This adds maintenance burden and should be a last
   resort, with SBOM and provenance retained.
5. Add a scheduled and release-time image scan. Fail on newly introduced applicable CRITICAL
   findings, while requiring an explicit, dated justification for temporary exceptions.

**Done when:** the chosen image has no unreviewed HIGH/CRITICAL findings, the digest is updated, the
acceptance suite passes, and rollback is rehearsed.

### 2. Eliminate Lavalink's recurring stats error without weakening isolation

**Why now:** one stack trace per minute makes real Lavalink errors difficult to see. The observed
cause is access to the host CPU thermal-throttle sysfs tree, not failed audio playback.

**Work:** reproduce under Docker and rootless Podman, search upstream Lavalink/OSHI fixes, and test a
new stable image first. If no upstream correction exists, use the narrowest documented runtime or
logging workaround. Do not grant privileged mode, broad host mounts, or additional capabilities
merely to collect CPU statistics.

**Done when:** a 30-minute idle and playback smoke test has no recurring `StatsCollector` error,
Lavalink stats/player updates still work, and the container remains read-only and capability-free.

### 3. Make the YouTube plugin startup deterministic

**Why now:** Lavalink currently downloads its plugin into an ephemeral tmpfs at every container
creation. A transient DNS failure caused one restart during this diagnostic. This makes readiness
depend on an external Maven service even when the application and base image are already present.

**Work:** prefer a verified plugin artifact baked into a reproducible image, or a checksum-verified,
bounded cache whose lifecycle and upgrade process are explicit. Preserve read-only runtime and do
not commit downloaded binaries without source, license, version, and checksum records.

**Done when:** a fresh start succeeds with the expected plugin artifact even during a simulated
repository outage, and plugin upgrades remain explicit and reviewable.

## P1 — reliability and engineering leverage

### 4. Add a production-grade bot health contract

The bot has no container healthcheck. Add an internal health mechanism that proves Discord ready,
Lavalink ready, command synchronization complete, and event-loop responsiveness without exposing a
host port or secret. Options include a container-local probe command or a health-state file in a
small dedicated tmpfs. Startup, liveness, and readiness must be distinguished so a temporary
Lavalink reconnect does not create a restart loop.

Use the same contract in Compose, Windows `doctor`, update/rollback readiness, and operational
documentation. Include image revision and process start time in private diagnostics so operators
can prove which release is running.

### 5. Exercise the real Compose stack in CI

Add an integration job that builds the bot image, starts Lavalink with a non-production test
password, waits on health, verifies `/version` and authenticated REST access inside the private
network, and cleanly shuts down. A fake Discord connector can validate WebSocket/session lifecycle
without a real token; real voice/DAVE remains a manual private-server acceptance test.

Also add:

- multi-architecture image builds for amd64 and arm64, at least on releases;
- cold-plugin-download and unavailable-repository scenarios;
- controlled Lavalink restart, reconnect exhaustion, and shutdown-race tests;
- container restart-count and log-noise assertions;
- a Windows test harness for manager behavior, not only PowerShell parsing.

### 6. Split the Discord adapter into cohesive modules

`src/discord.ts` owns command registration, autocomplete, interaction routing, response formatting,
voice-state handling, message lifecycle, diagnostics, presence, and service startup. Its size and
60.37% line coverage make otherwise-local changes expensive to reason about.

Extract pure or narrow modules for autocomplete, interaction adaptation, message/panel lifecycle,
presence, diagnostics formatting, and Discord service wiring. Preserve the existing typed manager
boundary and avoid a generic framework. Set an initial coverage floor around extracted logic and
raise it as branches move out of the SDK-heavy shell.

### 7. Split the music manager by policy while preserving one state owner

`src/music/manager.ts` is well tested, so decomposition should target readability rather than
behavioral redesign. Extract transition policy, watchdog/timer policy, diagnostics bookkeeping, and
play-request coordination into pure helpers. Keep one authoritative per-guild state owner and the
keyed serial executor; duplicating mutable queue state across services would regress race safety.

### 8. Add Discord interaction contract tests

Cover the currently thin paths with realistic SDK-shaped fakes or a local interaction adapter:

- defer/edit/follow-up behavior and error fallbacks;
- ephemeral permission denial for diagnostics;
- button updates, terminal/transient edit errors, and superseded messages;
- autocomplete timeout followed by late resolver completion;
- command synchronization failure and reconnect behavior;
- simultaneous event-driven and interval controls refresh.

Adopt coverage thresholds only after isolating generated/SDK glue. A useful first guard is no
overall regression plus explicit branch thresholds for extracted modules.

## P2 — hardening and usability of existing behavior

### 9. Coalesce controls-panel refreshes

Playback events and the one-second timer can request the same edit concurrently. Replace the
current drop-while-refreshing set with a per-guild dirty/coalescing loop: at most one edit in flight,
then exactly one follow-up render if state changed during that edit. Add bounded exponential retry
with jitter only for Discord rate limits and transient network errors; terminal errors should retire
the panel immediately.

### 10. Improve diagnostics interpretation

Keep `/diagnostics` private and metadata-free, but add:

- bot version/revision and uptime;
- Lavalink close/unavailable/session-loss counts already collected but not displayed;
- transport voice ping when available;
- warning labels for stale player updates, watchdog activation, or repeated panel failures;
- a reset boundary or "since process start" label so counters cannot be misread as lifetime data.

Do not add track titles, request text, requester IDs, guild IDs, raw endpoints, or secrets.

### 11. Bound and classify upstream work end to end

Autocomplete has a response deadline, but the underlying resolver request continues after Discord
stops waiting. Add cancellation or a shorter transport timeout if the Shoukaku/Lavalink API permits
it, and ensure abandoned autocomplete work cannot consume the play-request budget. Add response
categories for upstream rate limit, authentication/client failure, network timeout, and unavailable
media without exposing raw upstream errors to users.

### 12. Improve operational automation on Linux

Bring the transactional update behavior available on Windows to the Linux runbook or a small
operator script: validate clean `main`, record exact revision and image digests, pull/build, run the
health contract, restore automatically on failure, and retain the previous target. Never copy or
rewrite `.env`. Add log rotation/storage limits and disk-space preflight so unbounded container logs
cannot exhaust the host.

### 13. Produce release artifacts and provenance

Generate an SBOM for both images, retain scan reports, and attach release notes containing source
SHA, image digests, dependency changes, and rollback target. Consider signing built images only
after defining who controls the signing key and how Windows/Linux operators verify it.

### 14. Review interaction accessibility and localization readiness

Verify button labels/emojis remain understandable without color or artwork, empty/error states are
plain-language, durations and counts have consistent grammar, and focus order is sensible on mobile.
Centralize user-facing strings before attempting translation; do not add localization machinery
until there is an actual language requirement.

## P3 — conditional improvements

### 15. Minimal session recovery

Persistence is justified only if restart-related queue loss is a recurring problem. Before adding a
database, specify consent, retention, deletion, corruption recovery, schema migration, backup, and
whether requester/media metadata may be stored. Prefer a bounded per-guild queue snapshot with no
credentials and explicit expiry; keep persistence disabled by default.

### 16. Per-guild configuration

Introduce per-guild volume, loop, timeouts, or command roles only when multiple guilds need different
policy. This requires authorization, defaults/migration rules, storage, auditability, and a reset
path. Environment defaults remain simpler and safer for the current private deployment.

### 17. External monitoring and alerts

For a single private instance, `/diagnostics`, structured logs, container health, and host checks are
enough. Add Prometheus/Sentry/host alerts only if unattended uptime becomes important. Any endpoint
must remain private and must not export user/media metadata.

## Suggested execution order

1. Lavalink vulnerability reachability and replacement artifact.
2. StatsCollector noise and deterministic plugin packaging.
3. Shared bot health contract and Linux transactional deployment.
4. Real Compose/Windows behavior tests plus scheduled image scans.
5. Discord adapter decomposition and interaction coverage.
6. Music manager policy extraction and refresh coalescing.
7. Diagnostics/accessibility polish.
8. Reassess P3 items from actual operating evidence.

## Explicit non-goals for this plan

This document does not recommend public ports, privileged containers, floating image tags,
automatic secret migration, raw error exposure, a web dashboard, multi-node scaling, or persistence
without a privacy design. Those choices would expand Raydio's trust and operational boundaries and
need separate approval.
