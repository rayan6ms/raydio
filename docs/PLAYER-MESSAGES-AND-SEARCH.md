# Player messages and search behavior

The Rust bot keeps at most one owned “Now Playing” message per guild session.
Summoning the player again creates the new panel first and then retires the
previous message, including when `/play` adds to the current queue. This avoids leaving stale controls in a channel while still
preserving the working panel if Discord rejects the replacement. Stop, queue
completion (including skipping the last track), voice disconnect, invalidation, and session shutdown all retire the
owned panel as well. Deletion is asynchronous and bounded to three one-second
attempts. Up to sixteen deletions run concurrently; at that bound, new retirements
wait for a slot instead of dropping cleanup. Normal deletion does not wait in
the guild command loop; 404 means
the message is already gone and is treated as success.

Panel refresh tasks are cancelled when a panel is retired, but their reusable
task set remains open. A later `/nowplaying` can therefore create and refresh a
new panel in the same session.

Autocomplete only searches text terms (at least two characters) and is scoped
by guild, active voice channel, and case-folded query. Results are cached for
30 seconds, limited to ten choices, and filtered to valid unique YouTube
identifiers. Labels flatten control and excess whitespace, provide a fallback
title for missing metadata, and stay within Discord’s UTF-16 limits. Fully
qualified YouTube video and playlist URLs bypass search and are resolved
directly by `/play`; scheme-less text is intentionally treated as a search
term, matching the TypeScript bot.
