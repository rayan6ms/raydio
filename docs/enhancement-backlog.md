# Enhancement backlog

**Reviewed:** 2026-08-12
**Purpose:** keep future improvements evidence-led without expanding the bot accidentally

## Reliability first

1. **Playback event observability (completed):** correlate track start, end, exception, stuck, fallback,
   and controls-message refresh events per guild. Add counters for missed natural-end events and
   transient Discord edit failures so fixes can be based on production evidence.
2. **Graceful Lavalink shutdown (completed):** exercise repeated network-loss and shutdown races and
   ensure late Shoukaku errors are always handled instead of becoming unhandled EventEmitter
   errors. Keep this covered by an integration test, not only unit mocks.
3. **Session recovery (medium):** persist only the minimum queue/session intent needed to explain
   or recover from a bot restart. This needs a deliberate privacy and corruption policy before a
   database is added; the current in-memory behavior should remain the default until then.
4. **End-to-end playback probe (completed):** provide an operator-only diagnostic that verifies the
   Discord voice connection, Lavalink player, recent player updates, and last playback event without
   exposing tokens, URLs containing credentials, or requester data.

## Interaction and playback experience

1. **Event-driven controls refresh (completed):** refresh immediately on every queue/playback state
   change and retain the one-second interval only for progress. This reduces perceived latency and
   makes queue transitions independent of the periodic updater.
2. **Search refinement (medium):** measure whether two characters is enough to produce useful
   autocomplete results. Discord controls when the autocomplete panel opens; Raydio can return no
   choices and skip backend work, but cannot suppress the empty client panel while the option is
   focused.
3. **Richer queue context (completed):** show channel and duration for upcoming
   tracks, while preserving Discord's message and embed limits.
4. **Per-guild defaults (low):** consider configurable default volume, loop mode, and idle timeout
   only if the bot expands beyond a single private guild. Keep global environment defaults for the
   current deployment.

## Operations and maintenance

1. The release suite queues two deterministic tracks and proves natural advancement, controls-state
   replacement, and stale-button rejection. Audible acceptance remains an operational check.
2. Track dependency and Lavalink plugin upgrades in a staging deployment before production; include
   reconnect, playlist, autocomplete, and DAVE voice checks.
3. Bounded in-memory health counters cover node reconnects, playback failures, controls refresh,
   and watchdog activations without logging search text or secrets.
4. Windows deployment has a documented transactional rollback command and automatic failed-update
   recovery; keep verifying it after installer or container-runtime changes.

## Completed in the 2026-08-12 reliability pass

- Native `/play request:` results were restored, with backend searches gated until at least two
  characters and skipped entirely for HTTP(S) URLs.
- Play confirmation and the Now Playing panel identify the YouTube channel; finite durations are
  included in textual queue confirmation.
- Finite tracks have a duration-based fallback when Lavalink misses a natural end event. Pause,
  resume, replacement, stop, and cleanup cancel or reschedule that fallback safely.
- A transient Discord message-edit failure no longer permanently disables controls refresh.

## Completed in the 2026-08-12 observability pass

- Playback state changes refresh maintained controls panels immediately; the interval remains only
  for elapsed progress.
- `/diagnostics` is ephemeral and restricted to Manage Server. It reports bounded connection,
  queue, playback-event, watchdog, and message-refresh health without user or media metadata.
- Lavalink reconnect/session-loss/error counters are retained in memory, and late Shoukaku errors
  after shutdown remain handled.
- Windows updates retain a known-good revision, automatically restore it when new readiness checks
  fail, and expose a transactional `rollback` action.
- Queue output already includes channel, duration, requester, pagination, and finite remaining time;
  no additional message expansion is currently justified.

## Deliberately deferred

- Session persistence remains deferred until retention, consent, corruption recovery, and secret
  boundaries are explicitly chosen. Restarting with an empty in-memory queue is safer today.
- Per-guild defaults remain deferred until real multi-guild configuration demand exists.
- Search thresholds should be tuned from observed result quality rather than guessed; two
  characters remains the backend-work gate.
- Audible Discord/DAVE acceptance cannot be truthfully automated in unit tests. The release suite
  covers deterministic two-track transitions and UI state, while the private-guild audio smoke test
  remains an operational acceptance check.
