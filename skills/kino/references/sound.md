# Sound

Import a file first: `project {action:"import", file:"/absolute/path.m4a"}` answers its `src` and duration.

## Sound effects: finding and placing them

- Sources: the person's files first, else kino's CC0 effects: `library {topic:"sounds", search:"whoosh"}`, then `project {action:"import", file:"sfx:<id>"}`.
- Place each on an action the picture shows, never every text entrance. `mediaStart` is the scene time it plays at (on the action's frame, or 1-2 frames before a cut); give it `mediaSourceDuration` from the import.
- library {topic:"sounds"} (no search) lists the cut's visible actions, a sound each; edit {ops:[{op:"place_sounds", at:["a2","a5"]}]} lands each on its frame, 3 LU under the song.

```json
{"op":"add_layer","layerType":"audio","name":"buzz","properties":{"src":"/api/media/<id>.mp3","mediaStart":3.2,"mediaSourceDuration":0.8,"volume":0.6}}
```

## Sound: volume, fades and ducking

- Video and audio layers have `volume`, 0 (silent) to 4 (+12 dB; 1 is unchanged). Animate it with `from`/`to` `{volume}` (or plain numbers: `property:"volume", from:1, to:0.2`; `update_animation` too): fade in `kind:"in"` from 0, fade out `kind:"out"` to 0. A `linear` fade from or to 0 is equal power, so a crossfade holds its level.
- `duck_audio` dips music under the `under` layers (voices): by default 9 LU under the voice as measured, a transcribed voice for its words. List every voice-over in one `under`. A later `duck_audio` or `keep_line` adds its dips to the earlier ones (the summary lists all); `duck_audio` leaves lines `keep_line` kept as they are (receipt `keptLines`), and `replace:true` (send it after moving a voice-over) rebuilds those too. The receipt's `duck.summary` says where it dips. Several layers in one edit: `duck` is a list of reports (`duck[0].summary`). Depth, fades and section cues: `library {topic:"op", name:"duck_audio"}`. Without `to` each dip gets its own depth from its voices and the music under it: within 8 dB over 2 s unless a line needs more to stay 6 LU over the music; a line already 6 LU over gets none (`to:<volume>` dips it anyway). The music comes back up between two lines when both fades fit in a gap of 0.3 s or more. A dip crossing the song's drop ends on it (a line's last word running past it holds the dip to that word's end); the receipt's `payoff` gives the rise, or the line's level over the song at the drop and the volume that lifts it 6 LU over. Without `to` or `fadeUp`, lines 3 s apart or less that a dip per line would churn share one dip (receipt `joined`).
- Fade out after the last dip: an animation starting inside a dip takes over from it.
- Muffled until the drop: animate `lowpass` (Hz, 20-20000; none is off) 400 to 20000 over the bar before it, `kind:"in"`, `ease-in`.

```json
{"op":"add_layer","layerType":"audio","name":"music","properties":{"src":"/api/media/<music>.m4a"}}
{"op":"add_layer","layerType":"audio","name":"voice","properties":{"src":"/api/media/<voice>.m4a","mediaSourceDuration":2,"mediaStart":2}}
{"op":"add_animation","layer":"music","animation":{"kind":"in","start":0,"duration":1,"from":{"volume":0},"to":{"volume":1}}}
{"op":"add_animation","layer":"music","animation":{"kind":"out","start":5,"duration":1,"from":{"volume":1},"to":{"volume":0}}}
{"op":"add_animation","layer":"music","animation":{"kind":"in","start":1,"duration":2,"easing":"ease-in","from":{"lowpass":400},"to":{"lowpass":20000}}}
{"op":"duck_audio","layer":"music","under":["voice"]}
```

## Sound: the mix line and its fix

- `check {fix:"auto"}` measures each layer alone at a limiter place and turns down only the loudest cause (a hit, a loud word; within 1 dB a placed sound or clip goes before the song) by its own `xN`; a `keep_line` line keeps its level. A short clip is turned down whole, a long one dips only over the place (0.05 s Peak down / Peak up ramps); a layer whose volume moves there gets a dip that follows its curve.
- With `rules:[...]` the fix turns the mix down only when `"mix"` is among them (`rules:["mix"]` for the mix alone). The applied line names each fix (rule and layer, then `mix at 7.5 s, 9.5 s`); each place's layers, seconds and factors are on its `fixed mix` line. The `mix fix:` line gives LUFS and true peak before and after and ends 'turned down at N of M places; left: K places, worst ...; clears the rest: <call>'. Send that call: it names `check {fix:"auto"}` only when a rerun reaches the worst place, else it is one edit that dips the song there only.
- Plain check's mix line gives LUFS before the limiter and, in parentheses, after it (the file's level at `"off"`), and ends 'check {fix:"auto"} turns down N of M places; the rest: <edit>'.
- A song comes down whole (one `update_layer` volume by the lowest factor any place needs) only when its limiter places cover over 50% of its heard time. Under that it is never lowered whole: its dips stay, dips that would churn (`volume_churn`) join into one ('mix song: N places in 1 dip, not whole'), and places it cannot dip without churning are 'not applied' with their `xN`.
- Also 'not applied': a layer none of whose Volume animations starts or ends at its volume. Where `mix:` says `"auto"` adds a gain so the limiter never works, nothing needs fixing.
- The `cue:` and `ending:` lines after the mix line: sound-library reference ("Song cues and ending").

## Sound: music as structure

- Place a song with `fit_music {layer}`, not a typed offset: it plays one unbroken stretch of the song, its heaviest drop on the spine's payoff (or `payoff`) and sets the rhythm from a steady beat. A payoff that leaves the drop under 4 bars is kept, with a note. Its notes say where the turn and end fit. Then `duck_audio`. `recut:true` re-arranges in 4-bar groups.
- With no `end` the song's ending sets the video's: a phrase end up to 0.25 s before the scene end is taken (the scene end moves there, cue `song-end-<n>`), else the song's last hit (a bar line 0.3 to 1.2 s before the end, else a beat) rings out to the end (cue `song-ring-<n>`). The receipt's `ending` gives the video time, song second, kind and the frames the scene end moved or would need to; `board {music}` notes end with the same `; ending: ...`. With `end` the scene end stays: the song's own ending counts within 2 bars of it, else a 1 to 2 bar fade.
- fit_music with no payoff puts the drop where it plays the most whole 4-bar groups its section holds, 45% or more in; too short for a group, the receipt names the payoff that gives one.
- `music.sections` lists sections and seams, weight 0 to 1; cues `song-drop-1`, `song-dropout-`, `song-return-`, `song-vocal-in-`, `song-switch-` mark them where heard.

```json
{"op":"add_layer","layerType":"audio","name":"song","properties":{"src":"/api/media/<song>.m4a"}}
{"op":"fit_music","layer":"song","payoff":8}
```

## Cleaning a voiceover

Cut the slips out of a voiceover, then caption the rest (local whisper.cpp). `library {topic:"rules", name:"speech"}` has every rule.

1. `inspect {targets:["speech:<layer>"]}` lists the words as `index:word start` (scene seconds) and a flags line: `repeat`, `filler` (um, uh), `maybe` ("like": cut only if it is not meant), `unclear` (sound with no word), `low` (unsure words: check the spelling) and `pause`. `‖1.2` marks a pause that long. `speech:<layer>[file]`: the whole file in file seconds.
2. `cut_speech {layer, words:[indices]}` cuts those words (or `spans:[{from,to}]` in scene seconds). `pauses:0.4` shortens every pause over 0.4 s. The voice becomes pieces (`<name>`, `<name>-2` …) back to back with join fades; everything after a cut moves earlier (`ripple:false`: only the voice). Indices never change: cut more by them. A talking video morphs over each join in the render (preview and look: a dissolve; `morph:0.5`, `morph:false`). Undo: `restore:[indices]` or `restore:"all"`.
3. `add_captions {speech:"<layer>", fix:{"heard":"meant"}}` captions the words the voice plays now (no um/uh), correcting misheard names. Caption after cutting.
4. `check` transcribes every heard layer once. `speech_cut` gates a clip that starts or ends inside a word or mid-sentence; the fix moves the edge to the sentence end or start (a deliberate cut: `waive_check`). Warnings: `speech_fragment`, `mute_word`, `music_hard_stop`, `end_on_fade`, `no_music` (soundtrack.md); measured: `voice_under_bed` (a line under 6 LU over the beds), `voice_level_spread`, `bed_jump` (J-cut the new bed 0.5 s early), `volume_churn` (hold one level). The render cleans and levels lines to -16 LUFS (`voiceCleanup:false` skips it). `inspect {targets:["cuts"]}` lists cuts and the words near them. A waiver on a layer lapses when its file changes.

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"audio","name":"vo","properties":{"src":"/api/media/<voiceover>.wav"}}]}
{"tool":"inspect","targets":["speech:vo"]}
{"tool":"edit","ops":[{"op":"cut_speech","layer":"vo","words":[1,2,5],"pauses":0.4},{"op":"add_captions","speech":"vo","fix":{"Acmes":"Acme"}}]}
```
