# Footage: finding clips the person did not send

Read when the brief is an edit of something that exists (a series, a sport, a trip, a game) and
the person sent no clips, or too few. kino finds videos, scans them for their best shots and
imports only the shots you pick. The person's own clips always lead; found clips fill the gaps.

Contents: Three calls · Visual words, not names · Reading a scan · What is said · Note a video · Label a reference · Sources · Limits

## Three calls

```json
{"tool":"library","topic":"footage","search":"stub series fight","want":"bright, fast motion, close up"}
{"tool":"library","topic":"footage","scan":"top"}
{"tool":"project","action":"import","file":"F1","options":{"shots":[1,2]}}
```

1. `search`: the series or subject and the scene. Up to 10 videos, best first (the person's
   pasted link, verified channels, big channels), each `F1`, `F2`... for this video. Other
   people's edits, reactions, reviews, live and members-only videos are dropped. A video inspire
   listed, a saved reference, or one whose study shows a patch staying in place is flagged
   "someone else's edit", listed last; its scan's `next:` moves on (`data.import` keeps it).
   `want` is saved.
2. `scan` (`"top"`, `"F2"` or `"yt:<id>"`): downloads a 360p copy of the parts worth seeing
   (the whole video up to 8 min; else its most replayed parts and the chapters your words name,
   8 min in all; `from`/`to` for one stretch; `whole:true` up to 30 min), then lists the 12 best
   shots. It waits about 50 s; a longer scan answers with progress: send the same call again.
   Shot numbers: a code keeps its footage; a later scan of the same video numbers new shots
   on from the last. All saved shots are ranked and matched to the newest
   `want` together; the sheet is the newest scan's. Under half scanned, it names the next.
3. `import`: the shots you pick become H.264 clips (1080p at most), each with its credit, ready
   for `compose {footage:[...]}` or `add_layer`. `F1.37` alone imports one shot; `from`/`to` a
   stretch of 60 s at most. Only scanned videos import; 5 min a call, 15 min a project.
   Imports queue: a second waits behind the running one and answers when done (60 s, else
   "queued": repeat the call to read it). One line per clip: its `clip:` reference, then what it
   `says` or `heard`, or why none.

Scans and cut clips are kept by video id: ones another project made are reused ("already on this
computer: reused"), nothing downloaded. Another project's F code or `clip:yt-<id>` imports
that video under this project's own code.

The `kino` command sends `file=F1`, `file=F1.15` and `clip:` ids as typed.

`library {topic:"footage"}` lists the found videos again. `look {mode:"source", ref:"F1"}`
shows a scan's stills (`F1.<shot>`); look before you pick.

## Visual words, not names

The image model never learned character names: `want:"<character>"` matches nothing. Turn names
into what the camera sees: hair color, clothes, a mask or blindfold, the setting, the action
("white hair, blindfold, dark coat, fight, close up"). Put the names in `search` instead, where
YouTube's titles carry them. A match shows only when the best shot clearly beats the rest; else
the answer says "no visual match", how close the best came and what a match needs (or that the
image model did not run), and shots rank on motion, faces and clean frames.

## Reading a scan

`F1.37 3:17.2-3:19.0 1.8s motion 82 face 40 match +3.1`: shot 37 of F1, its time in the video,
length, motion and face (0 to 100), match (how far above the others it fits `want`). Shots full
of text, `subtitles` shots and shots under 0.4 s go last; `logo` marks a logo fixed for a while;
a dark shot keeps its rank (`dark, mean 13 of 255`). A burned-in mark is said once; such videos
list after clean ones. Import offers a clean clip or a crop; `frame_shot` keeps the mark out;
`burned_in_mark` names a layer still showing it (past 1.35x: a shift or a cover). Drawn footage has no face number ("Faces: not read
on drawn footage."). Skipped counts say what was left out. With a song in the video, the answer
says how many shots it needs (a cut every 2 beats on the drop, 4 on builds) and the import call
names up to 1.5 times that. The answer's `next:` is that import call: change the shots after looking.

## What is said

A scan reads the video's captions once (YouTube's own, your language first, then English; auto
captions are marked `auto captions`; no captions is said once). A shot line ends
`says: "..."` when a caption line overlaps it, and the answer ends with `Lines (en, auto
captions):` and `0:41 "..." (F1.12-F1.13)` rows. Auto captions are a guess (times within 0.5 s).

- `said:"words"` (with `search`, `scan` or alone; saved like `want`): shots whose lines say them
  go first, and a burned-in subtitle on such a shot is its line, so it reads `has subtitles`
  instead of ranking last. `next:` imports that line by its time range:
  `{"tool":"project","action":"import","file":"F1","options":{"from":4.9,"to":7.3}}`.
- No captions, or YouTube not answering: the answer says the words were not looked for.
- Import also listens: a clip of 1.5 s or more with sound and no caption line gets `heard "..."
  a-b s` (whisper on the clip's own sound, an English model: other languages come out as
  sound-alike words; keep_line `{from, to, text}` takes a translation). `look` source lists `heard:`
  per clip, and on one layer says `(muted here)` at volume 0. To keep a line over the song:
  `{"tool":"edit","ops":[{"op":"keep_line","layer":"climb","line":"I'm just gonna see.","duck":"song"},{"op":"isolate_voice","layer":"climb"}]}`.
  A line the trim cuts off is named `plays 5.3-7.4, line at 7.1-9.2` (file seconds); its call
  moves mediaOffset first.
- An import of a clip of 1.5 s or more adds `says "..." 0.3-2.1 s` (seconds in the clip).
- Keep a said line with `keep_line {layer:"clip", line:"the words said", duck:"music"}`: the rest
  of that clip's sound goes silent, a small subtitle shows the line, and the music dips to half
  (`dip` sets it). Speech whisper cannot read: `from`, `to` (scene seconds) and `text`.

## Note a video

```json
{"tool":"library","topic":"footage","note":{"id":"F1","verdict":"pick","why":"clean frames, no logo, the fight is in the first 4 minutes"}}
```

verdict is `pick`, `maybe` or `no`; a `no` moves on to the next video. Scanned, noted and
imported videos are never dropped from the list (24 kept).

## Label a reference

Numbers cannot see design (type family, overlays, composites, color, made graphics).
`library {topic:"inspire", name:"yt:X"}` ends with `on screen to label`: 6 moments. Look at each
with `look {mode:"reference", ref:"yt:X", t}`, then say what you see (an unlooked moment is refused), such as
`library {topic:"inspire", name:"seen yt:X @1.8 overlay, made: green outline traced on the figure"}`.
Kinds: type, overlay, composite, color, made, frame, spoken, plain (one or more, commas fine).
The time is one of the 6 (0.5 s off is fine); a label at the same time replaces the old one.
The order opens `label yt:X on screen (seen)` for each of the first 2 saved, studied references
until all its moments are labeled; each label reply names the next look.
Then ask what your edit shows that these do not: build toward the labels, not a template.

The check `reference_kinds` (an error) reads the labels: with 2 or more labeled references, a kind
(type, overlay, composite, color, made, spoken) that 2 of them show at 2 or more moments must show
somewhere in your edit, read every 0.5 s. Its fix (and `next`) is a ready call: `library {topic:"search",
search:"<label words>"}`, a kino overlay for made (1% of the frame at opacity 0.5+; overlays count),
or `keep_line` for spoken (also required by the references' measured voice when a clip says a line,
after `check {pixels:true}` transcribes it). Make your own version, not a copy.
Plain on purpose needs `waive_check {code:"reference_kinds", target:"<scene>", reason, quote}` with
`quote` in words the person typed that say what is plain (just cuts, music only...); "your call" is refused.
The search maps look words to kino names: font, outline, duotone, split screen, text behind, 3d,
code rain, zoom burst. A look kino cannot make answers `no kino name for ... yet`.

## Sources

- Each clip keeps its creator and link as metadata. Put no credits on screen unless the person asks.
- A final render's answer has one `Sources` line: pass it on only when the person says they will publish.
- `source:"commons"` searches Wikimedia Commons (needs the web search switch in Settings).

## Limits

- No cookies are ever sent. When YouTube asks for a bot check, kino pauses YouTube for 15
  minutes: use the person's clips or Commons meanwhile.
- A video that cannot play here (region, members only, age) is dropped.
- Nothing for the words: try the English title or `source:"commons"`.
- Found clips never stand in for a real moment of the person's story (needs reference: ask).
