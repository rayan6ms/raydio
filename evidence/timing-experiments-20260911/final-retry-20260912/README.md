# Final retry evidence — 2026-09-12

This is the corrected five-minute smoke run of the final Oracle candidate. The earlier `No options match your search` failure was a Discord UI test-harness state error: the harness injected raw editor text before Discord had parsed the Slate command state. It did not exercise Raydio playback.

The corrected harness pasted through Discord's editor, verified `/play`, the `request` option, and the exact URL, waited for a fresh player panel, enabled Loop on that panel, and started the receiver recorder only after a connected receiver peer was present.

`summary.json` reports complete PCM, polling, event, speaking, track-phase, and connection coverage for 300.010 seconds. It recorded zero net lost packets, zero unavailable frames, zero send failures, zero empty PCM frames, zero non-finite samples, and zero near-full-scale PCM samples. It observed 635.646 ms of aggregate concealment and 5 ms of silent concealment; these are receiver concealment counters, not proof of audible clipping. The run had 12 sender gaps >=40 ms and no gap >=100 ms.

This is functional evidence only; five minutes does not qualify a six-hour endurance run. Sender/resource deltas cover the interior checkpoint interval and the report records the uncovered head and tail.
