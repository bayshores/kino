# Sound library

kino has its own sound effects and music as a fallback: a video never waits for files or a
switch. A real song (soundtrack guide: named, searched or explored) is the default for music. The catalog ships with kino; each pack or track downloads once, on
first import, into kino's data folder and is checked against the catalog (SHA-256).

Contents: Sound effects · Music · Placing sound · A clip's own sounds · Separating voice

## Sound effects

- `library {topic:"sounds", search:"whoosh"}` lists up to 10 of 154 CC0 effects (Kenney's
  Interface and Sci-fi packs, OpenGameArt swishes, a whoosh, a camera shutter and real keyboard
  typing, a BigSoundBank crash reversed into a swell) as `sfx:<id> 0.4s -18 LUFS: words`.
  Search plain words for what happens on screen: whoosh, swish, click, tap, pop, drop, impact,
  boom, glitch, chime, confirm, error, zap, scroll, door, camera, typing, keypress, reverse
  cymbal (the riser: no CC0 synth riser exists yet). `full:true` allows up to 60 s.
- `project {action:"import", file:"sfx:<id>"}` adds it with its credit (CC0 needs none in the
  video, but the sound stop names it).
- Openverse only when the person turned on web
  search in kino Settings: `library {topic:"sounds", name:"openverse", search:"phone vibrate on a
  table"}` lists `openverse:<id>` sounds of 10 s or less with their license; import one the same
  way (kino keeps the MP3 preview and its credit as metadata). 20 searches a minute. With a free Freesound key in Settings, `freesound:<id>` sounds
  join the list; without it the answer says Freesound was not searched.

## Music

- Ask first: when the brief's `look_sound` says nothing about music, `library music` says so.
  Ask the person for a mood, or their own song, before you pick; their file always wins.
- `library {topic:"music", search:"uplifting high 110-130"}` filters by mood (uplifting,
  bright, playful, calm, warm, groovy, driving, tense, dark, mysterious, epic, sad, ambient),
  energy (low, medium, high) and a bpm or bpm range. Lines read
  `music:<id> 'Title' moods energy bpm length genre, drop at 31.5s` (or `no drop`). A drop is
  measured: a sudden jump (9 LU in a second) up to the track's loudest part; a soft swell is none.
- The order is this project's own, so two videos do not open on the same song. Take the
  first track that fits the story; do not reuse the last video's track unless asked.
- `project {action:"import", file:"music:<id>"}` imports it and measures its beat
  (`detect_beats`, `fit_music`). The tracks are Kevin MacLeod's (incompetech.com); the credit
  stays with the file.
- A track with a drop: put the video's key moment on it (`fit_music`), or start the track so
  the drop lands there. Without one, build energy with cuts and type instead.
- `look {mode:"board"}` page 1 prints the pace on each side of the song's turn beside your
  references', and the song's beat times after it; facts only. To put the cuts after the
  drop on those beats: edit {ops:[{op:"board", snap:"beats"}]}. Cut times only, song stays; a move
  over 6 frames lapses an approval. It keeps (and names) a cut that would run a shot past
  its file's end.
- `fit_music` alone after a board, under a late payoff, gives the same payoff-shot offer as
  `board {music}`: shot cues plus the `fit_music` payoff edit.

## Placing sound

- Quiet open: the first second or two carry little or no effect; let the music or the
  picture start the video.
- Impact finish: one hit (boom, impact) on the final reveal or logo, then let it ring out.
- Sound only on visible actions: a tap, a swipe, a card landing, a cut to a new place. Never on
  every text entrance, never a sub hit on a dim or a fade. Two or three in 15 s is plenty.
- Effects under music: place_sounds sets the level from the song ({at:8.4, what:"door"} or
  {at:8.4, sound:"sfx:<id>"}); by hand, volume 0.4-0.7. Name each one in the board's `sound`.
- place_sounds sets each effect's volume against the bed at the effect's own loudest heard
  window (a riser's end, an impact's ring), not at the action; a bed silent there is read 0.2 s
  either side of the action.
- At volume 2 and still short of its aim, the receipt's `sounds.louder` gives the next louder
  library sound of the same kind and one edit call that swaps it (it keeps your `under`).
- `what:"footstep"` and `what:"cloth"` are sounds kino makes in code (0.3 s, no download), so
  they work with no import. `what:` first takes an imported sound of 10 s or less whose name or
  credit has every word (never one the scene already plays), then the library. When neither
  matches, the refusal names the nearest library kinds and the call
  `library {topic:"inspire", search:"<same word>", kind:"sounds"}`: import the find, then
  `place_sounds {at, sound:"<its name>"}`.

## A clip's own sounds

- `look source {layer}` and a found-clip import give each clip's sound: `-23.4 LUFS · voice
  heard 2.8-3.0 s, words not read` (file seconds) is voice whisper could not read; keep it with
  `keep_line {layer:"shot-3", from:5.4, to:7.3}` (`from`/`to` are scene seconds).
- `keep_line` levels a clip line 6 LU over the song (never under -16 LUFS), up to +12 dB, and
  holds the mix; a line still short of the music gets the music out, and the note gives the LU
  short and a dip: that keeps the music in. Receipt: the mix vs the 2 s around.
- Music out for a line: `{op:"keep_line", layer:"clip", from:5.5, to:7.2, dropout:true}` (and
  `wait`): the music hits back on the downbeat within wait (default half a bar), else on the next
  beat; the receipt states the gap and the wait that reaches the downbeat. `dip` (0 to 1) sets a
  fixed dip instead (not both).
- With ggml-small.bin in ~/.kino/models/ (kino fetches it once, 488 MB), look source reads other
  languages: `heard in Japanese (ja, p 0.86): "..." [gloss (machine, unverified): "..."] 1.9-2.9 s`.
  A gloss is whisper's English and can reverse the meaning.
- Keep it as said: keep_line {layer, line:"<as printed>"} (subtitles show the words as said unless `text` is sent); show English: keep_line {layer, from, to, text:"<gloss>"}.
- A clip sound that is not a line (a laugh, a door, steps): `keep_line {layer:"<clip>",
  sound:"laughter"}` keeps its own level; the music dips only if it would mask it.
- The clip readout lists the surest sound under 0.5 as `maybe laughter (0.43) 1.0-2.0 s`;
  `keep_line {layer, sound:"laughter"}` keeps it, with a note.
- A layer can keep a line and a sound: the line is leveled (`voiceLevel`), the sound plays at
  its own level (`Sound up` / `Sound down`).

## Sound: separating voice from background

- `isolate_voice` splits a layer's sound locally (nothing is uploaded). `keep:"voice"`
  (default), `"background"`, or `"both"`: the voice plus an audio layer `<layer>-background`
  you can turn down. A video keeps its picture. `amount` 0–1 keeps some background.
- It does not duck music: send `duck_audio` in the same edit (`duck[n].summary` when it ducks several layers).

```json
{"op":"add_layer","layerType":"video","name":"interview","properties":{"src":"/api/media/<interview>.mp4"}}
{"op":"isolate_voice","layer":"interview","keep":"both"}
{"op":"update_layer","layer":"interview-background","properties":{"volume":0.3}}
```
