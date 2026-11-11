# Sound

Import a file first: `project {action:"import", file:"/absolute/path.m4a"}` answers its `src`
and duration.

Contents: Sound effects · Volume, fades and ducking · Music as structure · Separating voice from background · Cleaning a voiceover

## Sound effects: finding and placing them

- Sources: the person's own files first. Else kino's built-in CC0 effects:
  `library {topic:"sounds", search:"whoosh"}`, then `project {action:"import", file:"sfx:<id>"}`
  (Openverse and music: the sound-library guide). No ding or beep on nothing.
- Search what happens on screen ("swish", "click", "impact"), never a mood ("epic whoosh").
- Length fits the action: a tap or click 0.05-0.5 s, a slam 0.3-1 s, a whoosh under 1 s.
- Place each one on an action the picture shows (a tap, a message arriving, a cut to a new
  place), never on every text entrance: two or three in 15 s is plenty, and silence between
  them makes them land. `mediaStart` is the scene time it plays at (on the action's frame, or
  1-2 frames before a cut); give it `mediaSourceDuration` from the import.
- Effects under music: `volume` 0.4-0.7.
- Name every effect in the board's `sound` and its source at the sound stop.

```json
{"op":"add_layer","layerType":"audio","name":"buzz","properties":{"src":"/api/media/<id>.mp3","mediaStart":3.2,"mediaSourceDuration":0.8,"volume":0.6}}
```

## Sound: volume, fades and ducking

- Video and audio layers have `volume`, 0 (silent) to 4 (+12 dB; 1 is unchanged). Animate it
  with `from`/`to` `{volume}`: fade in `kind:"in"` from 0, fade out `kind:"out"` to 0. A `linear`
  fade from or to 0 is equal power, so a crossfade holds its level.
- `duck_audio` dips music under the `under` layers (voices). A given `to` is kept.
  Without it, dips sit 9 LU under the voice as rendered (else 0.25), one over 2 s stays within
  8 dB (`held`), and one goes deeper so each line in it is 6 LU over the music (`deeper`),
  to 0.1 at most (`quiet` names lines under). `fade` 0.15 s down, `fadeUp` 0.8 s up. A transcribed
  voice dips for its words; a measured sound without words (a whoosh,
  an untranscribed voice) dips while it is over -44 LUFS (`loud`). `warning`: a dip covers a section cue.
  Rerun after moving a voice-over. `summary` names each dip's layers. The music comes back up
  only for 3 s or more, never across a section cue (`sections`). List every voice-over in one `under`:
  a second `duck_audio` on a layer replaces its dips (`replaced`). When one edit
  ducks several layers, `duck` is a list with one such report per layer (`duck[0].summary`, …).
- Add a fade out after the last dip: an animation that starts inside a dip takes over from it.
- Muffled until the drop: animate `lowpass` (cutoff Hz, 20-20000; none is off) from 400 to
  20000 over the bar before it, `kind:"in"`, `ease-in` (example below).

```json
{"op":"add_layer","layerType":"audio","name":"music","properties":{"src":"/api/media/<music>.m4a"}}
{"op":"add_layer","layerType":"audio","name":"voice","properties":{"src":"/api/media/<voice>.m4a","mediaSourceDuration":2,"mediaStart":2}}
{"op":"add_animation","layer":"music","animation":{"kind":"in","start":0,"duration":1,"from":{"volume":0},"to":{"volume":1}}}
{"op":"add_animation","layer":"music","animation":{"kind":"out","start":5,"duration":1,"from":{"volume":1},"to":{"volume":0}}}
{"op":"add_animation","layer":"music","animation":{"kind":"in","start":1,"duration":2,"easing":"ease-in","from":{"lowpass":400},"to":{"lowpass":20000}}}
{"op":"duck_audio","layer":"music","under":["voice"]}
```

## Sound: music as structure

- `fit_music {layer}` plays one unbroken stretch of the song, its drop on the spine's payoff
  (or `payoff`): time the picture to it; its notes say where the turn and end fit the song.
  Then `duck_audio`. `recut:true` re-arranges in 4-bar groups.
- `music.sections` lists sections and seams, weight 0 to 1 ("8.01 s drop, weight 0.8
  (payoff)"); cues `song-drop-1`, `song-dropout-`, `song-return-`, `song-vocal-in-`,
  `song-switch-` mark them where heard.

```json
{"op":"add_layer","layerType":"audio","name":"song","properties":{"src":"/api/media/<song>.m4a"}}
{"op":"fit_music","layer":"song","payoff":8}
```

## Sound: separating voice from background

- `isolate_voice` splits an audio or video layer's sound on this computer (nothing is uploaded).
  `keep:"voice"` (default) plays only the voice, `"background"` only the rest, and `"both"` plays
  the voice and adds an audio layer `<layer>-background` with the same Play and volume, so you
  can turn either down. A video keeps its picture; only its sound changes.
- `amount` 0–1 (default 1) leaves some
  background in the voice. Running it again on one file is quick (`cached:true`).
- The receipt's `voice` gives the engine and seconds; a refusal names the problem (`voiceError`).
- `isolate_voice` does not duck music: send `duck_audio` in the same edit, and read where the
  music dips in the receipt's `duck.summary` (`duck[n].summary` when it ducks several layers).

```json
{"op":"add_layer","layerType":"video","name":"interview","properties":{"src":"/api/media/<interview>.mp4"}}
{"op":"isolate_voice","layer":"interview","keep":"both"}
{"op":"update_layer","layer":"interview-background","properties":{"volume":0.3}}
```

## Cleaning a voiceover

Cut the slips out of a voiceover, then caption the rest (local whisper.cpp). `library {topic:"rules", name:"speech"}` has every rule.

1. `inspect {targets:["speech:<layer>"]}` lists the words as `index:word start` (scene seconds)
   and a flags line: `repeat`, `filler` (um, uh), `maybe` ("like": cut only if it is not meant),
   `unclear` (sound with no word), `low` (unsure words: check the spelling) and `pause`.
   `‖1.2` marks a pause that long. The first inspect takes a sixth of the file's length.
   `speech:<layer>[file]`: the whole file in file seconds. whisper is told the brief's names; `re-heard`: unsure sentences heard alone.
2. `cut_speech {layer, words:[indices]}` cuts those words (or `spans:[{from,to}]` in scene
   seconds). `pauses:0.4` shortens every pause over 0.4 s. The voice becomes pieces
   (`<name>`, `<name>-2` …) back to back with join fades; everything after a cut moves
   earlier (`ripple:false`: only the voice). Indices never change: cut more by them.
   A talking video morphs over each join (0.3 s optical flow in the render; the preview, check
   and look show a dissolve; two shots stay cut; `morph:0.5`, `morph:false`). Undo: `restore:[indices]` (its `cut` line) or
   `restore:"all"`; it moves what the last cut moved.
3. `add_captions {speech:"<layer>", fix:{"heard":"meant"}}` captions the words the voice plays
   now, without um/uh, and corrects misheard names. Caption after cutting.
4. `check` transcribes every heard audio and video layer once. `speech_cut` gates a clip that
   starts or ends inside a word or mid-sentence (a full stop or 0.3 s pause ends one; words cut,
   muted, over silence under -40 dB, or in a gap between same-clock clips of one take do not count), or whose cut lands in
   loud sound near a word; a file that ends loud cuts its sentence off. A deliberate cut:
   `waive_check`. The fix moves the edge to the sentence end or start, never over a cut word (not
   auto over a shot's cut). Warnings:
   `speech_fragment` (a layer opens on a sentence's tail), `mute_word` (a mute or duck lets
   part of its word through), `music_hard_stop` (a song stops loud: `fit_music` or a fade),
   `end_on_fade` (fades out mid-phrase), `no_music` (soundtrack.md); measured: `voice_under_bed` (a line under 6 LU
   over the beds: music, street sound, any sound of 3 s or more; or 2 words in a row under 3 LU: lift
   them with a volume ramp or dip the beds), `voice_level_spread` (over 3 dB apart), `bed_jump` (beds
   rise over 8 LU at a cut: J-cut the new bed 0.5 s early with a 0.5 s fade, or match its level),
   `volume_churn` (a song or bed turns volume 3 times in 10 s: hold one level, duck once per spoken
   stretch). A waiver on a layer lapses when its file changes or it is deleted. Renders clean lines at volume 0.5+ (rumble cut,
   de-esser, gentle peak compressor, voice EQ), then level them to -16 LUFS (line by line in a clip whose lines differ by over 6 dB); `voiceCleanup:false` turns cleaning off.
   `inspect {targets:["cuts"]}` lists cuts, words around them, the dB jump. `speech_captions` warns when captions leave out heard words. With no
   speech model, check's notes say so. Sound effects are skipped.

If whisper-cli or its model is missing, the refusal says how to install them (macOS:
`brew install whisper-cpp`, and a model such as `ggml-small.en.bin` in `~/.kino/models/`).

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"audio","name":"vo","properties":{"src":"/api/media/<voiceover>.wav"}}]}
{"tool":"inspect","targets":["speech:vo"]}
{"tool":"edit","ops":[{"op":"cut_speech","layer":"vo","words":[1,2,5],"pauses":0.4},{"op":"add_captions","speech":"vo","fix":{"Acmes":"Acme"}}]}
```
