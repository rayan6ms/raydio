# Measured receiver improvement applied — 2026-10-03

The optional 120 ms receive-buffer target is now **enabled and left active**
in the controlled Discord tab. The prior experiments restored the default;
this implementation retains the setting after an observer finishes and
handles new voice peers and receivers in the same page. Its status after
verification confirms the live receivers still have a 120 ms target, with
zero application/restoration errors. Raydio remains connected and Loop is on.

This is a setting for this browser's incoming audio, including conversations.
It is not a server-side setting that Raydio can enforce on other listeners.
The helper does not modify the bot encoder, media loading or sender transport.

## Improvement and verification

The earlier matched default → 120 → default → 120 comparison is retained in
[the follow-up report](RECEIVER-BUFFER-FOLLOWUP-2026-10-03.md). Both settings
have ten measured minutes, the same receiver/track and full strict coverage:

| Setting | Concealed audio | Discarded packets | Net loss | Mean receive buffer |
| --- | ---: | ---: | ---: | ---: |
| Default | 162.75 ms | 4 | 0 | 62.90 ms |
| 120 ms target | 0 ms | 0 | 0 | 120.01 ms |

The cost measured in that comparison is **57.11 ms more receive buffering**.
This does not lower the encoder bitrate or change the codec. A buffer target
is a browser preference, not a guarantee of exactly 120 ms actual buffering.

A fresh five-minute verification of the installed helper ran at
**13:17:25–13:22:25 UTC / 10:17:25–10:22:25 São Paulo** on 2026-10-03, using
Raydio playing Akcent “Stay With Me” at volume 70 with Loop enabled:

| Metric | Installed-helper verification |
| --- | ---: |
| Receiver duration | 299.999 seconds |
| PCM observation | 300.021 seconds |
| Packets received | 14,996 |
| Net lost / positive loss deltas / negative corrections | 0 / 0 / 0 |
| Discarded packets | 0 |
| Concealment / silent concealment | 0 / 0 ms |
| Clipped / nonfinite samples / empty audio frames | 0 / 0 / 0 |
| Mean receive buffering | 111.00 ms |
| Target / helper changes during observation | 0 / 0 |
| Connection interruptions | 0 |
| NACK requests | 18 |
| Browser-inserted samples for deceleration | 70.31 ms |

Poll, PCM, event, speaking, track-phase and uninterrupted-connection coverage
all passed; stable-buffer coverage also passed. The browser performed a
small amount of timing adaptation and requested missing/out-of-order packets;
zero net loss does not mean packets never arrived late. No packet capture,
network probes, builds, test runners or further browser interactions ran
during this final interval. One 56 ms browser long task was observed.

Two approximately 2.26-second PCM quiet intervals are preserved separately
from concealment. This source-tail pattern was seen in the earlier matched
runs too. One event's visible-player snapshot was still at 238/249 seconds
and labelled `middle`; the second was at 248/249 and labelled `tail`. The
249.4-second repetition and nearby restart support the existing track-tail
interpretation, but UI phase is not an authoritative source audio clock. The
report retains both events rather than deleting the first or counting either
as lost-packet concealment. The receiver counters show no concealed samples
over the entire interval. This finite verification does not guarantee future
network behavior or all listeners' perceptual quality.

## Implementation and durability

The helper and optional extension are in
[clients/discord-receiver](../clients/discord-receiver/README.md).

- Applies to live audio receivers and observes future connections/track events,
  including description setup through a constructor cached before installation.
- Uses no timers, stats reads, per-packet processing, audio graph, recording,
  storage or external requests. JS plus manifest total approximately 9 KB.
- Releases ended tracks and closed connections. Native `close()` need not
  emit a state-change event, so it is hooked explicitly for cleanup.
- Preserves native construction, description arguments, errors and Promise
  identity; restores original values on disable where the helper still owns
  the setting. Later third-party settings/wrappers are preserved.
- Reports unsupported settings and bounded errors instead of silently
  claiming successful application.
- Diagnostics save initial/final helper state and buffer changes; changing the
  setting invalidates stable-buffer coverage. Buffer comparisons cannot run
  while the helper is enabled, and unstable new reports cannot qualify.

The current T3 tab retains the setting across voice reconnects. **Reloading
or reopening the tab clears it.** The supplied Chromium extension can apply
the same script at document start after reloads when installed in a regular
Chromium browser. It is ready for optional installation, but is not installed
in T3: the current preview tools expose no supported extension-install or
document-start injection API. No T3 internals or browser session stores were
modified to work around that limitation.

No Oracle deployment or bot restart was necessary for this listener setting.
No new Oracle process was added, and no change to bot memory/CPU is claimed.
The router and OS queue configuration were not changed: the inspected data
did not establish a queue-shaping fix for these late-arrival incidents.

## Checks and retained evidence

- Bun helper regression checks passed for existing/future/cached peers,
  unsupported settings, reconnects, native semantics, teardown without state
  events, and exact/third-party-safe restoration.
- Bun endurance and comparison-controller checks passed, including recording
  setting/helper changes and preventing conflicting trials.
- Five Python comparison tests passed, including rejection of unstable buffer
  observations and retention of invalid runs.
- A native-browser smoke check created two temporary WebRTC peers, applied
  120 ms through cached-constructor description setup, and closed both. Peer
  count returned to one, with no errors or restoration failures. Full native
  Promise identity is covered by the deterministic tests; the browser check
  confirms the returned value remains a native Promise.

An initial five-minute attempt recorded 15,000 packets and zero loss, discard
or concealment, but its PCM coverage was incomplete (299.467 seconds).
Five browser long tasks totaling 1,314 ms were observed while implementation
work continued. That coincidence does not establish the cause of the PCM
coverage gap. The attempt is retained under `initial/` and is not used as a
complete PCM-quality result. The quiet repeat under `verification/` passed
all coverage checks without relaxing any threshold.

Evidence: [receiver-buffer-enabled-20261003](receiver-buffer-enabled-20261003/),
including both terminal reports, host samples, event/window archives, derived
summary and post-verification installed state. Both temporary local collectors
have been stopped; the helper remains active without a collector.
