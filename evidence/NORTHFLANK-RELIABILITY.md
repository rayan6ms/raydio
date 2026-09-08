# Northflank candidate — 2026-09-08

The Developer Sandbox project `raydio-test` in US Central (Council Bluffs)
successfully ran Testbot using `deploy/testbot.Dockerfile`, build
`tiny-companion-1626`, repository commit `d9f28ff`. The image downloads the pinned
`v0.2.2-rc.1` native binary, whose source is `90bef68`; a packaging commit is not
a new audio implementation. Runtime allocation: one instance, 0.1 shared vCPU,
256 MB memory, 1 GB ephemeral storage. These are limits, not measured usage.

## Initial receiver screen

`northflank-screen-receiver.json` records 179.9995 seconds from
2026-09-08T15:04:37.052Z, using the controlled Discord browser as a muted
listener in test / General. Track: Never Gonna Give You Up, volume 70, loop on.

- 9,000 received packets; zero net loss, positive loss deltas, discards or NACKs.
- Zero concealed or silently concealed samples in the measurement window.
- Zero clipped/near-full-scale, empty or non-finite PCM samples.
- Longest quiet region: 10 ms; no unexpected silence events.
- Three receiver long tasks, 190 ms total, maximum 79 ms; zero missing PCM
  reports or stale polling intervals. Retain these receiver confounders.
- Track positions approximately 26–206 seconds: **no loop boundary covered**.

This is a promising short transmission result compared with the latest Oracle
ten-minute sample (632.292 ms concealment, seven discards, 22 NACKs), but the
durations and times differ. It proves neither a causal host advantage nor
six-hour reliability. Northflank's Observe charts did not supply usable CPU/RAM
measurements during this check. No resource-usage improvement is claimed.

## Free-plan verification

The team billing UI showed Developer Sandbox ($0/month), an active card and
$0 usage. Service billing showed "No usage" and no accrued costs. Its card
verification dialog stated that Developer Sandbox usage would not be charged.
The resources UI confirms "Autoscaling is not available on free projects."
No paid plan, addon, persistent volume, additional instance or BYOC selected.

The authenticated project-creation selector was also checked with all 17 regions
visible. Brazil (`southamerica-east`, Osasco) explicitly requires "Upgrade to pay
as you go to use this region." Only US Central (Council Bluffs) and Europe West
(London) lacked this restriction. No new project was submitted or paid region
selected. The official region documentation lists Brazil but does not itself
establish free-tier availability:
https://northflank.com/docs/v1/application/run/deploy-to-a-region.md

Official documentation says a card will not be charged until paid services are
created and used. The $50 billing threshold is an invoice trigger, **not a hard
spending cap**. Alerts are notifications, not enforcement. No hard $0 account
cap has been established, and this report does not guarantee future provider
terms or protect against future paid configuration changes.

- https://northflank.com/docs/v1/application/billing/add-a-card.md
- https://northflank.com/docs/v1/application/billing/billing-thresholds.md
- https://northflank.com/docs/v1/application/billing/monitor-spending.md

The service was scaled to zero after the screen before attempting Pella,
preventing duplicate Testbot sessions. Production Oracle was not changed.
CI/CD follows `rewrite/rust-raydio`: never push during an audio measurement
unless automatic deployment has first been disabled.
