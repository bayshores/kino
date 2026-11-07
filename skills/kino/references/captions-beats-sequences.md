# Captions, beats and sequences

Captions from a file, a transcript or plain text; cues from the music's beats; several scenes
played as one.

## Captions, beats and sequences

- Captions: `add_captions` with `file` (an absolute path to a .srt, .vtt or .txt file),
  `text` (a file's text, or plain text timed by reading speed between `start` and `end`) or
  `words` `[{text, start, end}]` from a transcript you already have. Never send sound to an
  outside service. `offset` moves file times (−107 shows the 1:47 line at 0 s). Pages follow
  common subtitle rules (42 characters a line, two lines, 20 characters a second, 5/6–7 s each);
  the receipt's `captions` counts pages and any that break a rule (`timing:"fit"` repairs
  short ones). Pages cut in and out; `appear:"fade"` fades them. An mp4, webm or mov `render`
  played forward also writes .srt and .vtt files beside the video, cut at `options.duration`.
- Caption looks: `look` sets font, size, place, entrance and phrasing with the rules built in:
  `subtitle`, `editorial` (pages), `clean`, `pop` (key word bigger in `accent`), `word`,
  `highlight` (the word being said in `accent`), `bold` (hook title). Phrase looks show words
  as said and hide in silences, stay up long enough to read (a phrase said too fast takes the
  next in, at most about 0.5 s behind the voice), and use 3 lines in portrait before shrinking;
  `hook:true` puts the first sentence big over the first seconds; `reduced:true` fades only. On a
  light frame with no footage, looks without a box take dark letters and a deep accent.
  Example: `add_captions` with `speech:"<voice layer>"`, `look:"pop"`, `keywords:["ship"]`.
- Text behind a person: `cut_out` with `layer:"<clip>"`, `behind:"<title>"` (person matte; when
  no person is found the title stays in front and the receipt's `cutout.fallback` says so).
- Word by word on one text layer: `add_animation` with `preset-custom-text` and `unit:"words"`,
  `stagger` (seconds between words), and `order`, `smoothing` if needed (text layers only); a
  custom animation's `delays` [s per word] times each word itself. Karaoke or word-pop timed to
  speech: `move caption-words` with `highlight:"active"`, `entrance:"pop"` (the moves reference).
- One animation, every letter timed (a range selector): `range` on an add_animation
  with a `unit`, in place of `stagger`. `"typewriter"` (soft, one after another), `"center-out"`
  and `"random"` (`{preset:"random", seed}`) work on an in or out; `"wave"` lifts each unit to
  `to` and back as it passes, so it needs a custom animation. Own selector: `{shape: square |
  ramp-up | ramp-down | triangle | round | smooth, start, end, offset}` (fractions of the text; a
  pair `[from, to]` sweeps with the easing), `smoothness`, `easeHigh`, `easeLow`, `amount`,
  `order: forward | reverse | random`; a list of up to 4 combines by `mode` (add, subtract, ...).
  `{shape:"wiggly", wiggles, correlation, seed}` jitters each unit around from on a custom
  animation. Change text and Counter `in`/`out` effects take `range` too.
- Beats: import the music, add it as an audio layer, and run `detect_beats` in the same edit
  (it reads the sound the ops before it set). It writes cues `beat-1`, `beat-2`, … and
  `onset-1`, … and sets the project's rhythm. The receipt's `beats` has bpm and confidence;
  under 0.5 the grid is a guess. Running it again (say after `replace_media`) can move beats;
  animations keep their times, and `beats.cuesMoved` lists those that started on a moved cue
  (`{"animation":"A1","cue":"beat-16","at":8.6,"moved":-0.53}`).
- Cues: `set_cues` names moments (`{"name":"drop","time":4.2}`). `inspect {targets:["cues"]}`
  (or `"cues[kind=beat]"`, `"cues[from=60,to=90]"`) lists cues with their times; start animations
  on those times. A long song has more cues than one answer holds: the answer lists the earliest
  and its last line names the target for the next ones (`cues[kind=beat,from=281.437]`).
- Footage cut to music: give `compose {footage, music}` a `pace` of `promo` (about 2 beats a
  shot, one hero hold up to 5.5 s) or `velocity` (1 beat a shot). Shots come in runs of one
  length in whole beats, every cut on the song's beat grid; the first 4 bars are calm, the last
  2 run twice as fast, and a zoom punch lands on the downbeats (`accents:false` turns it off).
- Sequences: build each part as its own scene (same size), then `add_sequence` makes one scene
  that plays them in order: `cut` (default), `crossfade`, `push`, `wipe`, `zoom`, `whip` (a
  push smeared by a directional blur) or `spin` (a turn under a spin blur), 0.5 s by default.
  Render the sequence scene. Parts stay editable; the sequence follows them.

```json
{"op":"add_captions","file":"/absolute/path/captions.srt","offset":0}
{"op":"add_captions","text":"Plan, build and ship from one place.","start":1,"end":4,"name":"tagline","position":"top"}
{"op":"add_layer","layerType":"text","name":"quote","properties":{"text":"Ship it today","x":200,"y":400,"width":1200,"height":140,"fontSize":96}}
{"op":"add_animation","layer":"quote","preset":"preset-custom-text","start":0,"duration":0.5,"unit":"words","stagger":0.27}
{"op":"add_animation","layer":"quote","preset":"preset-fade","start":0,"duration":1.2,"unit":"letters","range":"typewriter"}
{"op":"add_animation","layer":"quote","animation":{"kind":"custom","name":"Wave","start":2,"duration":1.5,"from":{"y":400},"to":{"y":376},"unit":"letters","range":"wave"}}
{"op":"add_layer","layerType":"audio","name":"music","properties":{"src":"/api/media/<id>.m4a"}}
{"op":"detect_beats","layer":"music"}
{"op":"set_cues","cues":[{"name":"drop","time":4.2}]}
{"op":"add_sequence","properties":{"name":"Film"},"scenes":["intro","demo","cta"],"transition":{"type":"crossfade","duration":0.4}}
```
