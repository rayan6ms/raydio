# Feature roadmap

**Reviewed:** 2026-08-12

**Scope:** new user-facing capabilities that could make the current private bot more useful

**Status:** ideas for selection, not implementation commitments

## How to use this roadmap

The priorities balance user value against complexity, privacy, source fragility, and operational
cost. Finish or explicitly accept the P0 work in `current-system-improvements.md` before starting a
feature. Implement one feature slice at a time with commands, buttons, permissions, limits,
diagnostics, documentation, and rollback behavior designed together.

Features should preserve Raydio's current principles:

- private-server scope and least Discord privilege;
- YouTube-first playback with no arbitrary URL fetching;
- bounded queues, messages, caches, and background work;
- no secret or requester data in public output or logs;
- no durable user/media history unless retention and deletion are designed first;
- graceful degradation when Discord, YouTube, or Lavalink is unavailable.

## Recommended next features

### F1. Explicit search picker

**Value:** high

**Complexity:** medium

**Recommended first feature:** yes

Add `/search query:` that returns the best 5–10 results with title, channel, duration, and a select
menu. Selection queues the exact result; cancel/expiry makes the menu harmless. This complements
autocomplete for ambiguous songs and works better when a user wants to compare channels before
committing.

**Guardrails:** search only after submission, 30–60 second session expiry, requester-only selection,
same-voice-channel revalidation at commit, no durable search history, bounded metadata, and no
automatic queue mutation on timeout.

### F2. Seek and replay controls

**Value:** high

**Complexity:** medium

Add `/seek position:` for finite seekable tracks and a Replay button or `/restart`. Accept clear
formats such as `90`, `1:30`, and `1h02m`; reject livestreams, negatives, and positions beyond
duration. The controls panel should refresh immediately and the natural-end watchdog must be
rescheduled from the new position.

### F3. Vote skip for shared voice channels

**Value:** medium to high in larger groups

**Complexity:** medium

Keep direct skip for the requester or server managers, and require a configurable majority of
eligible human listeners otherwise. Expose progress privately or in the voice-associated text
channel without pinging users.

**Guardrails:** count one vote per current track and user, discard votes on track/session changes,
exclude bots/deafened users according to a documented rule, and bypass voting for one-person
channels. Do not add this for the current private group unless control contention actually occurs.

### F4. Temporary queue ownership and moderation

**Value:** medium

**Complexity:** medium

Add optional DJ-role policy and commands to lock/unlock queue mutation, remove a requester's queued
tracks, or cap contributions per listener. Read-only queue/now-playing commands remain available.

**Guardrails:** default to today's permissive same-channel behavior, require Manage Server to change
policy, show the active policy in private diagnostics, and ensure managers can always stop/leave.

### F5. Bounded saved playlists

**Value:** high for repeat use

**Complexity:** high because it introduces persistence

Allow a server to save the current/upcoming queue under a name, list saved playlists, load one, and
delete it. Store normalized YouTube identifiers and minimal display metadata—not encoded Lavalink
tracks or requester identities—and re-resolve/validate items when loaded.

**Prerequisite:** approve storage location, quotas, retention, backup/restore, corruption handling,
name moderation, authorization, and deletion behavior. Keep the feature off by default until then.

## Good secondary features

### F6. Queue insertion modes

Add `/play-next`, or an optional `placement:` choice on `/play`, with `end` and `next`. Preserve
request ordering for concurrent work and make playlist insertion atomic. Avoid a broad set of queue
priority levels until there is evidence they are useful.

### F7. Remove and move by interactive selection

For short queues, let users select a track from a menu instead of remembering a number. Keep numeric
commands for long queues and keyboard-friendly use. Revalidate the queue generation so a selection
cannot affect a different track after concurrent edits.

### F8. Queue undo

Allow one short-lived undo for clear, shuffle, move, and remove. Keep only the minimum inverse data
in memory, bind it to the same playback session, expire it quickly, and invalidate it after
incompatible mutations. Do not treat undo as persistence or restore the currently playing track.

### F9. Playback filters

Offer a deliberately small set such as bass boost and normalization only after enabling and testing
the corresponding Lavalink filters. Show active filters in the player, clear them on session cleanup,
and cap CPU-expensive combinations. Novelty filters should not outrank reliability or accessibility.

### F10. Sleep timer

Add `/sleep after:` or `/sleep end-of-track` to stop or leave after a bounded duration/current track.
Show and cancel the timer from the controls panel. Tie timers to the playback-session token so stale
callbacks cannot stop a newer session.

### F11. Announce-next and compact mode

Offer per-session controls for whether each transition posts a compact now-playing message, edits a
single maintained panel, or stays quiet. Default to today's maintained panel to avoid channel spam.

### F12. Session-scoped autoplay recommendations

When the queue empties, optionally resolve a small number of related YouTube tracks based on the
current track. Make this opt-in per session, label recommendations, cap consecutive additions,
honor duration/livestream rules, and stop after repeated failures. Do not infer long-term taste or
retain listening profiles.

## Conditional or specialist features

### F13. Lyrics

Lyrics require a licensed, stable provider and strict message-length/copyright handling. Link to or
show a short provider-authorized excerpt rather than scraping arbitrary sites. Treat synchronized
lyrics as a separate, substantially larger integration.

### F14. Additional sources

Spotify links are commonly useful as metadata inputs, but Spotify playback itself is not available
through ordinary track URLs; a safe design would map metadata to an allowed playback source and
clearly disclose the match. SoundCloud playback requires enabling another Lavalink source and its
own reliability/security review. Never enable arbitrary HTTP/local playback for convenience.

### F15. Stage-channel support

Supporting Stage channels needs speaker request/suppression lifecycle, permissions, and additional
voice-state race handling. Implement only if a real server uses Stages and explicitly test both
moderator and non-moderator transitions.

### F16. Scheduled playback

Scheduled playlists or alarms require time zones, missed-run behavior, authorization, persistence,
and rules for joining an empty channel. This is closer to an automation service than an ordinary
music command and should remain opt-in and administrator-managed.

### F17. Web dashboard

A dashboard adds public/private HTTP ingress, authentication, CSRF/session security, authorization,
deployment certificates, and a second UI. It is not justified for the current bot while Discord
commands and private diagnostics cover administration.

### F18. Crossfade, gapless playback, and advanced audio processing

These can be constrained by Lavalink/Discord buffering and may increase CPU and transition races.
Prototype only after ordinary natural advancement is stable under long playback tests, and define
what "gapless" can honestly mean over Discord voice.

## Features not recommended for the current trust boundary

- Arbitrary HTTP URLs or local filesystem playback.
- User-uploaded audio without malware, copyright, quota, and retention controls.
- Public multi-tenant hosting or a shared public Lavalink endpoint.
- Listening-profile analytics, global user history, or opaque recommendation tracking.
- AI-generated DJ speech or summaries by default; it adds cost, latency, moderation, and data-sharing
  concerns without improving core playback.
- Automatic migration or cloud synchronization of `.env` secrets.

## Suggested feature sequence

1. Explicit search picker.
2. Seek/replay.
3. Interactive queue selection and next-placement.
4. Sleep timer and queue undo.
5. Vote skip/DJ policy only if shared-channel demand exists.
6. Persistence-backed saved playlists only after the privacy/storage design is approved.
7. Filters or autoplay recommendations as isolated, opt-in experiments.
8. Reassess specialist features from real usage rather than feature parity with public bots.

## Definition of ready for any feature

A feature is ready to implement only when it has:

1. a user problem and success criterion;
2. command and mobile interaction design;
3. same-channel and manager authorization rules;
4. queue/session race behavior and stale-control behavior;
5. memory, request, and message bounds;
6. privacy/logging/retention rules;
7. unavailable-upstream and rollback behavior;
8. unit, interaction, and operational acceptance tests;
9. documentation and private diagnostic coverage;
10. an explicit decision about whether it is enabled by default.
