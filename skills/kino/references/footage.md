# Footage: finding clips the person did not send

Read when the brief is an edit of something that exists (a series, a sport, a trip, a game) and
the person sent no clips, or too few. kino finds videos, scans their best shots and imports the
shots you pick. The person's own clips lead; found clips fill the gaps.

Contents: Three calls · Visual words, not names · Reading a scan · What is said · Note a video · Label a reference

## Three calls

```json
{"tool":"library","topic":"footage","search":"stub series fight","want":"bright, fast motion, close up"}
{"tool":"library","topic":"footage","scan":"top"}
{"tool":"project","action":"import","file":"F1","options":{"shots":[1,2]}}
```

1. `search`: the series or subject and the scene. Up to 10 videos, best first (the person's
   link, verified and big channels), each `F1`, `F2`... Other people's edits, reactions,
   reviews, live and members-only videos are dropped; a likely edit (inspire listed it, a saved
   reference, a fixed patch) is flagged "someone else's edit" and listed last. `want` is saved.
2. `scan` (`"top"`, `"F2"` or `"yt:<id>"`): downloads a 360p copy of the parts worth seeing (8
   min; its most replayed parts and the chapters your words name; `from`/`to` one stretch;
   `whole:true` up to 30 min), then lists the 12 best shots. It waits about 50 s; a longer
   scan answers with progress: send the same call again. A later scan numbers new shots on
   from the last; all saved shots rank against the newest `want`.
3. `import`: the shots you pick become H.264 clips (1080p at most), each with its credit, ready
   for `compose {footage:[...]}` or `add_layer`. `F1.37` imports one shot; `from`/`to` a stretch
   of 60 s at most; 5 min a call, 15 min a project. A second import queues ("queued": repeat
   the call). One line per clip: its `clip:` reference, what it `says` or `heard`, or why none.

Scans and clips are kept by video id and reused across projects; another project's F code or
`clip:yt-<id>` imports under this project's own code. The `kino` command sends `file=F1`,
`file=F1.15` and `clip:` ids as typed.

`library {topic:"footage"}` lists the found videos. `look {mode:"source", ref:"F1"}` shows a
scan's stills (`F1.<shot>`); look before you pick.

## Visual words, not names

The image model never learned character names: `want:"<character>"` matches nothing. Turn names
into what the camera sees: hair color, clothes, a mask or blindfold, the setting, the action
("white hair, blindfold, dark coat, fight, close up"). Put the names in `search` instead, where
YouTube's titles carry them. A match shows only when the best shot clearly beats the rest; else
the answer says "no visual match", how close it came and what a match needs (or that the model
did not run), and shots rank on motion, faces and clean frames.

## Reading a scan

`F1.37 3:17.2-3:19.0 1.8s motion 82 camera light 13 dark face 40 (upper left, 9% of frame) wide (figure 42% high, bottom, room 97%) match +3.1`:
shot 37 of F1, its time, length, motion (0 to 100) and how it moves (`still`, `subject` or
`camera`), `light` (mean of 255; under 31 is `dark`, and keeps its rank), `face P (where, S% of
frame)` or, where no face was read, `salient (where, S% of frame)` (where the eye goes, not that
something is there: a near-black frame gets a box of about 30%), the framing, and match (how far
above the others it fits `want`). Framing: `close` = face 25% of height or more, `medium` = face
8% or more or figure 60% or more, else `wide`; figure = whole-body box, else the face box; room =
the share of the frame outside it. Shots full of text, `subtitles` shots and shots under 0.4 s go
last; `logo` marks a logo fixed for a while. A burned-in mark is said once; such videos list after
clean ones. Import offers a clean clip or a crop; `frame_shot` keeps the mark out; `burned_in_mark`
names a layer still showing it (past 1.35x: a shift or a cover). On drawn footage Vision rarely
finds a body, so shots carry only the motion word: no figure, height, room or scale tag.

Narrow a scan: `library {topic:"footage", scan:"F8", filter:{face:true, brighter:60, longer:2}, sort:"length"}`; the import call then names only those shots. Filter keys: `face`, `speech` (true or false), `figure` (true or false: a whole body on at least 25% of the frames read), `brighter`, `darker` (light of 255), `longer`, `shorter` (seconds), `bigger` (box, % of frame), `scale` (`"wide"`, `"medium"`, `"close"` or a list), `height` (% of frame height: N for at least N, or [low, high]), `room` (over N % of the frame outside the box), `moving` (`"still"`, `"subject"`, `"camera"` or a list). Sort: light, dark, length, size, motion, time, wide (smallest figure first), close (tallest first), room (most room first). Subject and place in one frame: `filter:{figure:true, scale:"wide", room:80}`. A fact the scan never measured (speech with no captions or listening) is named in `Not measured, left out` and not applied. With a song, the answer says how many shots it needs (a cut every 2 beats
on the drop, 4 on builds); its `next:` imports up to 1.5 times that: change the shots after looking.

## What is said

A scan reads the video's captions once (YouTube's own, your language first, then English; auto
captions are marked `auto captions`; no captions is said once). A shot line ends
`says: "..."` when a caption line overlaps it, and the answer ends with `Lines (en, auto
captions):` and `0:41 "..." (F1.12-F1.13)` rows. Auto captions are a guess (times within 0.5 s).

- `said:"words"` (with `search`, `scan` or alone; saved like `want`): shots whose lines say them
  go first, and a burned-in subtitle on such a shot is its line, so it reads `has subtitles`
  instead of ranking last. `next:` imports that line by its time range:
  `{"tool":"project","action":"import","file":"F1","options":{"from":4.9,"to":7.3}}`.
- No captions? `said:"<words>"` listens to the scanned part here (English only, about 6-13 s a
  minute): `library {"topic":"footage","scan":"F1","said":"protect them"}`. The scan's
  `Lines (<lang>, heard on this computer)` are heard in the clip's own language, each with its
  gloss, when ggml-small.bin is already in `~/.kino/models` (the scan never fetches it).
- Import also listens: a clip of 1.5 s or more adds `says "..." 0.3-2.1 s` (clip seconds), or
  with no caption line `heard "..."` (whisper: other languages as said, with an English gloss,
  when ggml-small.bin is installed). `look` source lists `heard:` per clip (`(muted here)` at 0).
- Keep a said line: `keep_line {layer, line, duck}`: the rest of the clip goes silent, a
  subtitle shows the line, the music dips to sit 6 LU under it (`dip` sets another). Unread speech
  or a translation: `from`, `to` (scene seconds) and `text`. A trim that cuts the line off: its
  call moves mediaOffset first.
  Over a song: `{"tool":"edit","ops":[{"op":"keep_line","layer":"climb","line":"I'm just gonna see.","duck":"song"},{"op":"isolate_voice","layer":"climb"}]}`.
- compose {footage} keeps the clips' best lines heard (one per 6 s; `lines`: a number, [texts] or false).

## Note a video

```json
{"tool":"library","topic":"footage","note":{"id":"F1","verdict":"pick","why":"clean frames, no logo, the fight is in the first 4 minutes"}}
```

verdict is `pick`, `maybe` or `no`; a `no` moves on to the next video. Scanned, noted and
imported videos are never dropped from the list (24 kept).

## Label a reference

Numbers cannot see design (type family, overlays, composites, color, made graphics).
`library {topic:"inspire", name:"yt:X"}` ends with `on screen to label`: 6 moments. Look at each
with `look {mode:"reference", ref:"yt:X", t}`, then say what you see (an unlooked moment is
refused), such as
`library {topic:"inspire", name:"seen yt:X @1.8 overlay, made: green outline traced on the figure"}`.
Kinds: type, overlay, composite, color, made, frame, spoken, plain (one or more, commas fine).
The time is one of the 6 (0.5 s off is fine; a `type` label may be at any second); a label at the
same time replaces the old. The order opens `label yt:X on screen (seen)` for each of the first 2
saved, studied references until all its moments are labeled; each reply names the next look.
Build toward the labels, not a template.

The check `reference_kinds` (advice): a kind that 2 labeled references show at 2 or more moments
should show somewhere in your edit. It names a free moment and a ready call (a library search, a
kino overlay for made, `keep_line` for spoken). Make your own version, not a copy.
Plain on purpose needs `waive_check {code:"reference_kinds", target:"<scene>", reason, quote}` with
`quote` in the person's words that say what is plain (just cuts, music only...); "your call" is refused.
The search maps look words to kino names (font, outline, duotone, split screen, text behind, 3d,
code rain, zoom burst); a look kino cannot make answers `no kino name for ... yet`.

Credits, Commons, bot checks and limits: needs reference.
