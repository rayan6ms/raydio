# Search admission and incomplete deferred replies

## Observed incident

Raydio revision `9391775` on Oracle played two queued tracks in `test` on
2026-10-02. A later `/play akcent stay with me` in `THE CLUB → comandos` did
not produce search suggestions, join voice, or complete its deferred reply.
Discord created message `1555601246558097462` at 15:23:58 UTC with the LOADING
flag (128) and no content. When inspected later in the browser, it showed
“The application did not respond.”

The service was active, still at the expected revision, and Testbot was inactive.
Neither THE CLUB nor test has guild command overrides that could select an older
command schema. THE CLUB was inspected only; no test messages or commands were
sent there.

## Findings and corrections

1. Autocomplete previously required cached bot roles before searching. Discord
   does not guarantee that GUILD_CREATE includes our membership; a server with
   missing bot roles received empty suggestions until `/play` fetched that member.
   Autocomplete now hydrates the same membership used by `/play`, subject to
   the existing bounded search semaphore. It still requires the caller to be
   in an accessible voice channel, rechecks permissions before using cached
   choices, and keeps results scoped to the guild and voice channel.
2. A lost or delayed HTTP response to the initial defer previously made
   `acknowledge` return false even if Discord accepted it. The guild actor then
   discarded the command without completing the visible “thinking” message.
   Ambiguous transport errors/timeouts now receive one bounded lookup of the
   original interaction response. Only confirmed acceptance allows execution;
   terminal rejection still prevents it. The actor acknowledgement budget includes
   this extra lookup.
3. The timeout on reply completion and lazy membership loading previously ended
   when response headers arrived. Reading/decoding a stalled body had no deadline.
   Those deadlines now cover the complete response. Error replies get one bounded
   idempotent retry for transient failures.
4. Discord acknowledgement and reply errors were silently discarded. Logs now
   include command receipt, acknowledgement, voice admission, source resolution,
   and reply completion/failure, with guild/interaction identifiers and safe numeric
   HTTP/API error codes. They do not format HTTP errors, bodies, URLs or tokens.

Autocomplete's 1.9-second work budget includes membership retrieval and source
loading, followed by the existing 350-ms response budget. Cached membership incurs
no new network request during normal searches. No audio path or dependency pin
changed.

The historical log did not contain command-stage or response errors, so it cannot
prove which of the acknowledgement, stalled body, or failed reply paths caused
this particular incomplete response. The regression tests establish the bugs;
a fresh request on the instrumented deployment is needed to correlate any further
failure precisely.

THE CLUB's public voice channels allow the bot role's basic voice permissions.
Some private VIP channels explicitly deny View Channel and Connect to @everyone
and do not allow the Raydio role/member. Those permissions were left untouched;
requests there should receive the relevant permission error instead of playback.

## Validation

- Regression: autocomplete hydrates missing bot roles once, returns scoped cached
  choices, and does not reuse them after permissions are revoked or in another guild.
- Regression: an accepted defer with a delayed HTTP response is recovered; an absent
  defer and a terminal Discord rejection are not executed.
- Regression: a response with immediate headers and a stalled body times out.
- Full Raydio library, main, backend integration, reconnect integration and doc tests.
- Clippy across all targets with warnings denied and formatting checks.

Live testing is restricted to `test` and, if needed, `Romanvs 💪`. The user submits
the playback commands; the controlled browser is used to inspect the result.

## Deployment and live validation

Release `acb277c1b1ad14b79ef2e0912ee57cb1ba9c022c` was pushed to
`rewrite/rust-raydio` and deployed on the existing Oracle instance at 16:09 UTC.
The deployed binary's SHA-256 matches the locally tested release. Raydio reported
Discord readiness; Testbot remained inactive. All 54 library tests, the main
test, backend and reconnect integration tests, and doc tests passed. Clippy across
all targets passed with warnings denied.

The user submitted a fresh playback request in `test → #chat` while connected
to General. Interaction `1555613110176579707` was received at 16:11:07 UTC,
acknowledged in 310 ms, admitted, and resolved successfully in 985 ms. The first
Web media handoff returned `Source(InvalidResponse)`; the existing client fallback
recovered. At 16:11:25 UTC the original reply completed and the backend reported
the track started. The signed-in Discord UI showed Raydio in General and a
progressing player for “Stay With Me” by Akcent - Topic at volume 70.

This confirms successful playback and reply completion in the test server. The
membership regression is covered by the fixture that explicitly omits bot roles;
this live request does not establish the cause of the older THE CLUB incident.

The user also tested `Romanvs 💪 → 🎵︱músicas` and confirmed normal search and
playback in both servers. Romanvs interaction `1555613451597119620` was received
at 16:12:28 UTC, acknowledged in 547 ms, and resolved in 1167 ms. Its Web media
handoff also failed and recovered through the existing fallback; the reply
completed and the track started at 16:12:45 UTC. The browser showed the official
Akcent “Stay With Me” player progressing in Romanvs. Neither request produced
an acknowledgement/reply error or a service restart. THE CLUB remained
inspection-only throughout.
