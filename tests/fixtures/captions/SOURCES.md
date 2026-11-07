# Caption test fixtures

## sintel_en.srt

The English subtitles of the open movie *Sintel*, unchanged (1,514 bytes, SHA-256
`4ed7e1f1bc5ff69fe33606960e4c048ba6766237bf33b132fef76e1a92cb64b2`), downloaded on 2026-10-18 from
<https://www.sintel.org/wp-content/content/subtitles/sintel_en.srt>, the subtitle link on the
film's download page.

© Blender Foundation | www.sintel.org. Licensed under Creative Commons Attribution 3.0
(<https://creativecommons.org/licenses/by/3.0/>): "The results of the Durian Open Movie project are
being licensed under the Creative Commons Attribution 3.0 license"
(<https://durian.blender.org/sharing/>).

The tests use it as a real subtitle file: it starts with a blank line, has two-line events, and its
times run past kino's two-minute scene limit, so imports shift it with `offset`.
