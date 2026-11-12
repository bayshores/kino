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

The `kino` command sends `project import file=F1`, `file=F1.15` and `clip:` ids as typed.

`library {topic:"footage"}` lists this video's found videos again. `look {mode:"source",
ref:"F1"}` shows a scan's stills labeled `F1.<shot>`; look at them before you pick.

## Visual words, not names

The image model never learned character names: `want:"<character>"` matches nothing. Turn names
into what the camera sees: hair color, clothes, a mask or blindfold, the setting, the action
("white hair, blindfold, dark coat, fight, close up"). Put the names in `search` instead, where
YouTube's titles carry them. A match shows only when the best shot clearly beats the rest; else
the answer says "no visual match", how close the best came and what a match needs (or that the
image model did not run), and shots rank on motion, faces and clean frames.

## Reading a scan

`F1.37 3:17.2-3:19.0 1.8s motion 82 face 40 match +3.1`: shot 37 of F1, its time in the video,
length, motion and face (0 to 100), match (how far above the others it fits `want`). Dark shots,
shots full of text, `subtitles` shots and shots under 0.4 s go last; `logo` marks a logo fixed
for a while. A small logo near an edge on most shots is said once ("Logo top-left on every
shot: crop or cover it."), and such videos list after clean ones; subtitles and captions stay text. Drawn footage has no face number ("Faces: not read
on drawn footage."). Skipped counts say what was left out. With a song in the video, the answer
says how many shots it needs (a cut every 2 beats on the drop, 4 on builds) and the import call
names up to 1.5 times that. The answer's `next:` is that import call: change the shots after looking.

## What is said

A scan reads the video's captions once (YouTube's own, your language first, then English; auto
captions are marked `auto captions`; no captions is said once, and is normal). A shot line ends
`says: "..."` when a caption line overlaps it, and the answer ends with `Lines (en, auto
captions):` and `0:41 "..." (F1.12-F1.13)` rows. Auto captions are a recognizer's guess: read
their times to the nearest half second and their words as probably right.

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
  The song alone is a valid cut. A line the trim cuts off is named `plays 5.3-7.4, line at 7.1-9.2`
  (file seconds), and its call moves mediaOffset first to play it whole.
- An import of a clip of 1.5 s or more adds `says "..." 0.3-2.1 s` (seconds in the clip).
- Footage has its own sound, and a line said in a clip can open or set up a moment. Keep it with
  `keep_line {layer:"clip", line:"the words said", duck:"music"}`: the rest of that
  clip's sound goes silent (every piece of a cut voice), a small subtitle shows the line, and the
  music dips to half its own volume (`dip` sets the volume) under it. Speech whisper cannot read: `from`, `to` (scene seconds) and `text`.

## Note a video

```json
{"tool":"library","topic":"footage","note":{"id":"F1","verdict":"pick","why":"clean frames, no logo, the fight is in the first 4 minutes"}}
```

verdict is `pick`, `maybe` or `no`; a `no` moves on to the next video. Scanned, noted and
imported videos are never dropped from the list (24 kept).

## Label a reference

Numbers cannot see design: a reference's type family, overlays, composites, color work and made
graphics are only seen. `library {topic:"inspire", name:"yt:X"}` ends its fingerprint with `on screen to label`: 6
moments. Look at each with `look {mode:"reference", ref:"yt:X", t}`, then say what you see in your
own words (a moment you did not look at is refused), such as
`library {topic:"inspire", name:"seen yt:X @1.8 overlay, made: green outline traced on the figure"}`.
Kinds: type, overlay, composite, color, made, frame, spoken, plain (one or more, commas fine).
The time is one of the 6 (0.5 s off is fine); a label at the same time replaces the old one.
The order opens `label yt:X on screen (seen)` for each of the first 2 saved, studied references
until all its moments are labeled (one with no frame strips has none); each label reply names the next look. Then ask
what your edit shows that these do not: the labels are what you build toward, not a template.

The check `reference_kinds` (an error) reads the labels: with 2 or more labeled references, a kind
(type, overlay, composite, color, made, spoken) that 2 of them show at 2 or more moments must show
somewhere in your edit, read every 0.5 s. Its fix (and its `next`) names the library search for the label's words
(`library {topic:"search", search:"<words>"}`): use kino's own tools to make your version, not a copy.
Plain on purpose needs `waive_check {code:"reference_kinds", target:"<scene>", reason, quote}` with
`quote` in words the person typed that say what is plain (plain, raw, no effects, just cuts...); "your call" is refused.
Only references with most moments labeled count. Spoken is judged only after the clips are transcribed (`check {pixels:true}`); no-op color, letterbox bars and backing boxes do not count.
The search maps look words to kino names: font, outline, duotone, split screen, text behind, 3d,
code rain, zoom burst. A look kino cannot make (speed lines) answers `no kino name for ... yet`.

## Sources

- Each clip keeps its creator and link as metadata. Put no credits on screen unless the person asks.
- A final render's answer has one `Sources` line: pass it on only when the person says they will publish.
- `source:"commons"` searches Wikimedia Commons (needs the web search switch in Settings).

## Limits

- No cookies are ever sent. When YouTube asks for a bot check, kino pauses YouTube for 15
  minutes: use the person's clips or Commons meanwhile.
- A video that cannot play here (region, members only, age) is dropped.
- Nothing for the words: try the English title, a character name or `source:"commons"`.
- Found clips never stand in for a real moment of the person's story (needs reference: ask).
