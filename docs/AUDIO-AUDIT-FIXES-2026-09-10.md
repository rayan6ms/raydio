# Audio audit repairs — 2026-09-10

This implements findings A1–A7 from [the transmission audit](AUDIO-TRANSMISSION-AUDIT-2026-09-10.md).
The changes improve bounded recovery and correct reproduced defects. They do
not establish that the previous 30-packet delivery loss was caused by the bot.
Fresh deployment and receiver results will be recorded separately below.

| Finding | Repair | Verification |
| --- | --- | --- |
| A1: abandoned audio lifecycle operation | Crust owns each admitted operation until completion and serializes subsequent operations behind it; backend shutdown retains its registry until cleanup completes. | Dropped attach, replacement, Stop and shutdown waiters; concurrent shutdown; an additional Stop test drops the waiter during the actual silence drain, while the audio slot is Busy. |
| A2: one UDP error ends playback | Oto retries a recoverable send up to three total attempts, with a 20 ms wait between retries. Permanent/short sends fail immediately; exhaustion reports Fatal. | Injected transient failure resumes the exact staged payload. Independently decrypted packets retain contiguous RTP sequence/time and monotonic nonces. Repeated failures terminate after three attempts. |
| A3: indefinite DAVE wait | A ten-second not-ready budget survives WebSocket resume. Duplicated controls/heartbeats cannot replenish it; fresh transport ownership resets it. Expiry reports a typed DAVE failure. | Fake-clock initial/reset/duplicate scenarios, plus real socket resume; existing short-rekey, replacement and Stop regressions. This surfaces failure requiring fresh voice setup; it does not invent unsupported DAVE recovery. |
| A4: truncated HTTP body | Reopen the exact consumed offset only under an unchanged strong ETag, matching range and total size. Retry count is bounded for the input lifetime; one recovery episode shares one request deadline and cannot extend beyond the failed range. | Exact recovered bytes; missing/changed identity, range/length mismatch, repeated partial progress, cancellation and total deadline tests. No additional media buffer. |
| A5: seek after finite EOF | Retain the finite session through EOF/drain, recreate decoder history on seek, and restore MP4 demuxer state after EOF. | Exact PCM and encoded replay across ordinary/fragmented AAC, HE-AAC v1/v2, FLAC, MP3, Vorbis and resampled PCM as applicable. |
| A6: invalid karaoke output | Validate parameter domains and coefficient finiteness before chain replacement; expose a typed filter configuration error. | Invalid/extreme parameters rejected, valid boundaries remain finite, previous accepted configuration survives a rejected update. No per-sample validation scan added. |
| A7: unused stuck threshold | Time actual pending source reads using the configured threshold. Emit one event per blocked demand; retain that same pending read and frame. | Fake-clock threshold changes, recovery, EOF, cancellation and unpolled demand; integration checks identity/userData, pause and stale generation suppression. |

Exact replay also exposed a native HE-AAC priming artifact: libxaac reported
scratch bytes as PCM before synthesizing its first frame with error concealment
enabled. The native patch clears only that priming output. AAC decoder recreation
also resets noise-substitution history that the upstream reset method retained.
The MP4 fork is narrowly renamed, retains MPL-2.0 notices, and documents removal
criteria in Mantle's `third_party/symphonia-format-isomp4/MANTLE-PATCH.md`.

UDP retries resend the already encrypted, unsent datagram. Tokio's UDP send is
cancellation-safe, so cancelling a Pending send emits no datagram. No new
encryption or counter rollback occurs during retry. Retries can delay a frame;
they do not improve its codec quality or recover packets lost after a successful
send. Existing pacing rebases after a delayed send to avoid backlog bursts.

The DAVE deadline is observed at gateway loop/connection boundaries. Existing
bounded writes/control work or reconnect backoff can delay reporting slightly;
it is not a hard real-time ten-second guarantee. Cryptographic readiness remains
mandatory before any media is sent.

## Validation and measurement

The full Mantle suite, exact replay extensions, Oto suite and Crust suite pass.
The receiver harness passes synthetic PCM timing/clipping/nonfinite tests,
checkpoint recovery and six-hour simulated event-retention tests. A simulated
run is not a six-hour Internet audio qualification.

The fresh Oracle baseline uses the previous deployed binary, the same isolated
Testbot systemd unit, two runtime workers and `MALLOC_ARENA_MAX=2`. After thirty
seconds of authenticated idle, four samples five seconds apart reported
12,681 KiB PSS, 15,056 KiB RSS and three threads. No measurable CPU increment
occurred in those fifteen seconds (10 ms accounting resolution). The candidate
must be measured under the same conditions before drawing a memory conclusion.

The independent live check will retain receiver peer/SSRC identity, packet-loss
corrections, concealment, PCM quiet intervals/clipping, browser scheduling,
sender snapshots, source boundaries, process memory/CPU and host pressure.
Fresh source output is decoded independently before classifying natural tails.
No builds, packet tracing or repeated SSH logins belong in the quiet window.

Two independent receiver networks would be needed to locate delivery failures
more precisely; one receiver cannot identify the network hop that lost a packet.
The optional research opportunities in the audit (FEC policy, gateway traffic
fairness, batching, receive feedback and corruption counters) are distinct from
these seven reproduced/configuration defects and are not claimed as implemented.
