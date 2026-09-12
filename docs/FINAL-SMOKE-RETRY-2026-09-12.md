# Final smoke retry and pacing decision — 2026-09-12

## Discord submission failure

The `No options match your search` error was a test-harness/UI-state bug. The harness had inserted `/play` as raw DOM text while Discord's Slate editor had not parsed the command and option state. That left an incomplete command, so the UI rejected it before Raydio received an interaction. The production bot was not the source of this error.

The harness was corrected to paste through the editor's paste handler, verify the parsed `/play` command, `request` option, and exact URL, require a connected receiver observer, wait for a fresh player panel, and enable Loop on that new panel. The corrected five-minute retry completed with full receiver coverage and no receiver error. See `evidence/timing-experiments-20260911/final-retry-20260912/`.

## Pacing candidate

The 10 ms minimum-spacing candidate was rejected and reverted after a matched ten-minute comparison:

| Metric | Original pacer | 10 ms candidate |
|---|---:|---:|
| Sender gaps >=40 ms | 6 / 9 min (~40/hour) | 16 / 9 min (~106.7/hour) |
| Concealment | 390.3 ms / 10 min | 791.5 ms / 10 min |
| Concealment rate | 39.0 ms/min | 79.1 ms/min |
| Net packet loss | 0 | 0 |
| Silent concealment | 0 | 0 |
| Discards | 3 | 7 |
| Median PSS | 16.60 MiB | 16.26 MiB |
| CPU | 3.86% | 3.82% |

The candidate's small memory and CPU advantage was outweighed by materially worse delivery continuity and more concealment. No pacing, codec, bitrate, FEC, or jitter-buffer change from that experiment was promoted. The later 18 ms recovery experiment was also rejected for worse long-gap and mixed-concealment behavior.

The final retry therefore verifies the reverted/original pacing path plus diagnostics and test safeguards. It does not claim that the rejected candidate improved the bot; its code was removed. Changes retained after the experiment are observability, evidence validation, and safer Discord test setup.
