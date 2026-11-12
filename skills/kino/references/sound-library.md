# Sound library

kino has its own sound effects and music as a fallback: a video never waits for files or a
switch. A real song (soundtrack guide: named, searched or explored) is the default for music. The catalog ships with kino; each pack or track downloads once, on
first import, into kino's data folder and is checked against the catalog (SHA-256).

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

## Placing sound

- Quiet open: the first second or two carry little or no effect; let the music or the
  picture start the video.
- Impact finish: one hit (boom, impact) on the final reveal or logo, then let it ring out.
- Sound only on visible actions: a tap, a swipe, a card landing, a cut to a new place. Never on
  every text entrance, never a sub hit on a dim or a fade. Two or three in 15 s is plenty.
- Effects under music: place_sounds sets the level from the song ({at:8.4, what:"door"} or
  {at:8.4, sound:"sfx:<id>"}); by hand, volume 0.4-0.7. Name each one in the board's `sound`.
