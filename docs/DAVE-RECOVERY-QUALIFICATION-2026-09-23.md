# Encrypted voice recovery qualification — 2026-09-23

## Scope and diagnosis

Testbot only, on the existing free Oracle instance; production Raydio remains disabled. The experimental audio worker is disabled. This qualifies recovery separately from six-hour endurance and worker comparisons.

The previous receiver failure and subsequent bot failure are distinct. The later sender failure followed the last listener leaving, a new initial DAVE epoch, and readiness not returning. It does not explain the initial receiver/network failure.

An initial two-retry candidate failed a real listener departure on September 23: departure at 16:01:23.776 UTC, fresh encrypted handshakes at 16:01:34.162 and 16:01:44.265, terminal ReadinessTimeout at 16:01:54.380, listener return requested at 16:02:00.348. Retrying while the room was empty exhausted the budget before the listener returned. Earlier integration clicks at 16:00 did not actually disconnect; they are not successful fault tests.

## Final candidate

- Oto `e84d316e07ab64c62f0737ae6818d55f627527da`: confirmed empty rooms receive a bounded 120-second readiness grace; listener return uses the normal ten-second deadline. Duplicate messages cannot replenish the current deadline. Unknown membership does not receive empty-room grace.
- Discord client-connect batches accumulate and deduplicate, with the member limit enforced across batches. The DAVE core receives the complete roster.
- At most two fresh encrypted handshakes per external credential generation. Recovery retains the audio attachment and gates media on encryption readiness. No encryption bypass or unbounded reconnect loop.
- Crust `617da27a3217c88c0a3f2a82f0f50ec211666429`: final Oto pins and sanitized empty-room/recovery diagnostics.
- Raydio preserves its existing 120-second alone-disconnect policy. Dev-only Oto is aligned with runtime Oto, removing duplicate test dependencies. The root crypto patch remains on its previous revision because the vendored implementation is unchanged.

## Automated validation

Oto: 117 passed, nine release-only tests intentionally ignored; Clippy all-targets with warnings denied passed. Regressions cover a 40-second empty room, bounded duplicate-roster handling, accumulated membership, retention of the source, encrypted-only resumption, and retry exhaustion.

Crust Oto adapter: 16 passed, one ignored.

Raydio: 53 tests passed (50 library, one binary, one backend, one reconnect integration). Lockfile changes are limited to the intended git revisions and removal of duplicate Oto/Davey test dependencies.

Live qualification: pending final build. Evidence is under `evidence/dave-recovery-20260923/`; the failed first live candidate is retained separately from final qualification.
