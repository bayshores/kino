# Inspire test fixtures

## ytsearch-fast-cut-walking-edit.jsonl

What `yt-dlp --ignore-config --no-cookies --no-cache-dir --flat-playlist --dump-json
"ytsearch6:fast cut walking edit"` printed on 2026-10-26 (yt-dlp 2026.10.21): public metadata of
six YouTube videos (id, link, title, length, channel, thumbnail links), one JSON object a line,
cut down to the fields kino reads and a few it ignores. No video, picture or sound was downloaded
for it, and none is in the repository.

## stub-yt-dlp.mjs

A stand-in for yt-dlp that never goes online: it prints the recorded search above and "downloads"
a video the test made with FFmpeg; asked to describe one linked video, it prints that video's line
from the recorded search, or made-up metadata (see the comment at its top). The tests make their videos in a
temporary folder each run.

## shorts-app-launch-animation.jsonl

What `yt-dlp --ignore-config --no-cookies --no-cache-dir --flat-playlist --dump-json
--playlist-end 6 "https://www.youtube.com/results?search_query=app%20launch%20animation&sp=EgIQCQ%3D%3D"`
(YouTube's Shorts filter) printed on 2026-10-30 (yt-dlp 2026.10.21): the first three of six
Shorts, cut down to the fields kino reads and a few it ignores, one thumbnail link each. Nothing
was downloaded for it.
