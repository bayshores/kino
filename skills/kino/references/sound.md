# Sound

Import a file first: `project {action:"import", file:"/absolute/path.m4a"}` answers its `src`
and duration.

Contents: Sound effects · Volume, fades and ducking · Music as structure · Separating voice from background · Cleaning a voiceover

## Sound effects: finding and placing them

- Sources: the person's own files first. Else kino's built-in CC0 effects:
  `library {topic:"sounds", search:"whoosh"}`, then `project {action:"import", file:"sfx:<id>"}`
  (Openverse and music: the sound-library guide). No ding or beep on nothing.
- Search the on-screen action ("swish", "click"), never a mood ("epic whoosh").
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
- `duck_audio` dips music under the `under` layers (voices): by default 9 LU under the voice
  as measured, a transcribed voice for its words. List every voice-over in one `under` (a
  second run replaces the dips) and rerun after moving one; the receipt's `duck.summary` says
  where it dips. Depth, fades and section cues: `library {topic:"op", name:"duck_audio"}`.
  Without `to` a dip over 2 s stays within 8 dB (`held`) unless a line needs it deeper to stay
  6 LU over the music (`deeper`), down to 0.1 (`quiet` names lines still under); dips keep apart
  at a section cue (`sections`).
- Fade out after the last dip: an animation starting inside a dip takes over from it.
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
  Then `duck_audio`. `recut:true` re-arranges in 4-bar groups; the song's own ending
  counts within 2 bars of `end`, else a fade.
- `music.sections` lists sections and seams, weight 0 to 1 ("8.01 s drop, weight 0.8
  (payoff)"); cues `song-drop-1`, `song-dropout-`, `song-return-`, `song-vocal-in-`,
  `song-switch-` mark them where heard.

```json
{"op":"add_layer","layerType":"audio","name":"song","properties":{"src":"/api/media/<song>.m4a"}}
{"op":"fit_music","layer":"song","payoff":8}
```

## Sound: separating voice from background

- `isolate_voice` splits a layer's sound on this computer (nothing is uploaded). `keep:"voice"`
  (default), `"background"`, or `"both"`: the voice plus an audio layer `<layer>-background`
  you can turn down. A video keeps its picture. `amount` 0–1 leaves some background in.
- It does not duck music: send `duck_audio` in the same edit.

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
   `speech:<layer>[file]`: the whole file in file seconds.
2. `cut_speech {layer, words:[indices]}` cuts those words (or `spans:[{from,to}]` in scene
   seconds). `pauses:0.4` shortens every pause over 0.4 s. The voice becomes pieces
   (`<name>`, `<name>-2` …) back to back with join fades; everything after a cut moves
   earlier (`ripple:false`: only the voice). Indices never change: cut more by them. A talking
   video morphs over each join in the render (preview and look: a dissolve; `morph:0.5`,
   `morph:false`). Undo: `restore:[indices]` or `restore:"all"`.
3. `add_captions {speech:"<layer>", fix:{"heard":"meant"}}` captions the words the voice plays
   now, without um/uh, and corrects misheard names. Caption after cutting.
4. `check` transcribes every heard layer once. `speech_cut` gates a clip that starts or ends
   inside a word or mid-sentence; the fix moves the edge to the sentence end or start (a
   deliberate cut: `waive_check`). Warnings: `speech_fragment`, `mute_word`,
   `music_hard_stop`, `end_on_fade`, `no_music` (soundtrack.md); measured: `voice_under_bed` (a
   line under 6 LU over the beds), `voice_level_spread`, `bed_jump` (J-cut the new bed 0.5 s
   early), `volume_churn` (hold one level). The render cleans and levels lines to -16 LUFS
   (`voiceCleanup:false` skips it). `inspect {targets:["cuts"]}` lists cuts and the words near them.
   A waiver on a layer lapses when its file changes. With no speech model, check says so.

If whisper-cli or its model is missing, the refusal says how to install them (macOS:
`brew install whisper-cpp`, and a model such as `ggml-small.en.bin` in `~/.kino/models/`).

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"audio","name":"vo","properties":{"src":"/api/media/<voiceover>.wav"}}]}
{"tool":"inspect","targets":["speech:vo"]}
{"tool":"edit","ops":[{"op":"cut_speech","layer":"vo","words":[1,2,5],"pauses":0.4},{"op":"add_captions","speech":"vo","fix":{"Acmes":"Acme"}}]}
```
