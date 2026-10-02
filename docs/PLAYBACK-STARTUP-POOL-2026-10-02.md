# Sub-five-second startup investigation

The preceding deployed build `5f23955` took 6.947476 seconds from command receipt
to processing TrackStartEvent for `4moWSMi1L_4`, with 5.637977 seconds in media
opening. The user's target is below five seconds without degradation. Retain the
same selected format, complete bounded staging before playback, and existing
voice/DSP/pacing settings. TrackStart is a sender lifecycle measurement, not an
exact first-audible-frame timestamp at the listener.

## Transport experiments

Bounded same-source Oracle probes fetched itag 251, 142,217 bit/s, 4,167,934 bytes
through the existing home SOCKS egress. Header, range-query and POST variations
all returned identical SHA-256
`a31c27999d21b6402368699057c277597e906ca88e4ab68ab3cf6322df685097`.
Initial controls took 4.191/4.141 seconds versus 3.499 seconds for query and
3.497 seconds for POST. Repetition varied from 2.733 to 4.875 seconds, with one
redirect/two connections each. The alternatives lacked a stable advantage;
neither request semantics nor signed URLs are changed.

A Rust source-only harness using Mantle's actual downloader measured response
setup at 0.620–0.832 seconds and full staging at 3.270–6.151 seconds. Thus the
dominant residual wait is transport, not decoding or voice setup. These were
bounded diagnostics, not Discord receiver tests; no probes run during the final
live comparison.

## Verified connection-reuse bug and fix

ureq finalizes a length-delimited response on the read after its last payload.
HttpRangeInput previously dropped the reader at the last byte, closing that
socket instead of returning it to the pool. A keep-alive regression failed
before the correction: three staged objects still opened three connections
with a shared agent. The fixed reader explicitly observes EOF locally. Media
openers also reuse the source manager's existing pool when their transport
policies match. Routed clients and custom policy retain independent agents.

The controlled three-object, 4 MiB/object, 20 ms/connect fixture measured:

| Transport | Connections | Total open/read time |
| --- | ---: | ---: |
| Separate clients | 3 | 152.927 ms |
| Shared pool, completed bodies | 1 | 108.237 ms |

This is 66.7% fewer connections and 29.2% lower fixture time. It does not predict
cold-start improvement when no reusable connection exists. Complete staging,
exact range/length/identity validation, bounds, cancellation, and replay remain.
No bitrate, encoder, gain, packet pacing or read-ahead setting changes.

## Oracle source-only preservation check

An interleaved actual Mantle source harness discovered, completely staged, and
drained the same video five times. It ran without Discord transmission; a
new manager represented an independent pool, while one shared manager served
the three pooled cases.

| Case | Discovery | Media open | Output frames |
| --- | ---: | ---: | ---: |
| Separate 1 | 171.922 ms | 4683.874 ms | 12,460 |
| Shared first | 173.301 ms | 3742.077 ms | 12,460 |
| Shared second | 113.825 ms | 3219.094 ms | 12,460 |
| Separate 2 | 129.569 ms | 4184.836 ms | 12,460 |
| Shared third | 123.428 ms | 3489.625 ms | 12,460 |

Every output used OpusPassthrough and had the same packet MD5
`de9da549be67cb676d8c5f6eb5c8d9ba`. This confirms exact packet preservation in
these samples; it does not measure volume processing or live packet loss.
Shared second response setup was 352.456 ms versus separate controls
822.143/907.599 ms. Shared first had no existing media socket and must not be
treated as causal pooling evidence. Network/CDN caches and routing were not
controlled. Test scripts kept credentials and signed URLs internal and emitted
only bounded safe timing/status/digest fields.

## Validation and remaining qualification

Mantle's full media suite and all-target Clippy with warnings denied pass, with
existing live/process/environment exclusions unchanged. Regressions cover
transport-policy mismatch, routed pooling exclusion, cancellation, exact bytes,
incomplete-body recovery, stale metadata, changed identity, and real Opus/AAC
replay. Deployment and a fresh user-submitted command are required to report
whether total startup is below five seconds. No new six-hour or receiver result
is inferred from these transport checks.

Published dependency pins: Mantle
`775d64f85912bfcf96814ff404144300f34cb635`, Crust
`7876fd86f744865882b802d5cf203a70488992e5`. Crust's 32 adapter tests and
all-target Clippy pass (two existing manual benchmarks excluded). Raydio's
54 library tests, main test, backend/reconnect integrations, all-target Clippy
and formatting pass. The lock diff preserves all registry packages/dependencies
and Oto's `62d2fc87e5dc239695a8b86a7372a4edc1caa933` correction.

The bounded release build and backend self-check pass. The controlled browser
is signed in to test → General, muted and undeafened. The existing receiver
observer is installed before voice creation; its peer reports Connected. A
one-hour, 96 MiB/10% CPU bounded loopback collector saves the five-minute audit
independently of agent turns. Browser-to-collector health returns HTTP 200.
Full persistence is verified again once a real advancing audit starts.
