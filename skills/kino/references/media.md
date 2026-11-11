# Media

Images, video, audio and GIFs: bringing a file in, swapping it, and playing it faster, slower or
backwards, syncing two clips of the same moment, and B-roll on the spoken word. Sound levels,
ducking and voice separation are in the sound reference.

Contents: Importing and replacing files · Cutting and skipping inside a clip · Clip speed ·
Syncing two clips · B-roll on the spoken word

## Importing and replacing files

- `project {action:"import", file:"/absolute/path.png"}` (CLI: `kino project import /abs/clip.mp4`,
  or `path=`/`file=`) returns a `src` for an image, video or
  audio layer. A media layer draws only that `/api/media/…` address or a `data:` image; a file
  name, a path or a web address is refused, and so is an image, video or audio add_layer with no
  `src` (or an update_layer that clears it): import first, then add the layer. For video and audio it also gives the measured duration in seconds; its
  add_layer example sets that as `mediaSourceDuration`, so Play stops where the file ends.
- Video can be .mp4, .webm, .mov or .m4v. A .mov or .m4v (what iPhones record) is kept as an
  .mp4 with the same picture, copied and not encoded again: H.264 and HEVC import this way, and
  the new `src` ends in `.mp4`. Another picture codec (ProRes, for example) is refused with an
  ffmpeg line that converts it.
- Log footage (flat, gray): a video tagged BT.2020 with no transfer curve, as Apple Log is, imports
  with `log:"apple-log"` in its add_layer example, which shows it as Rec.709. `log:null` shows the
  file as recorded. Set log yourself on a log clip the tags missed. replace_media sets log from the
  new file's import.
- A video's import answer also lists its shots in file seconds (`shots: 3: 1) 0–1.25 s …`),
  found with FFmpeg's scdet filter; a flash of a few frames is not a cut. If the FFmpeg kino
  uses is older than 5.1 or lacks the scdet or signalstats filter, kino refuses the video, says
  so and saves nothing.
- `library {topic:"media", search?, page?}` lists imported files, 30 a page.
- Play: `mediaStart` (scene seconds it starts), `mediaOffset` (file seconds it starts from),
  `mediaDuration`. edit and inspect read trimStart or inPoint as mediaOffset, startTime as mediaStart.
- `replace_media {layer, mediaId}` (the imported file's name with its extension) swaps the file
  and keeps the layer's box, transform, effects and animations. Audio replaces only audio.
- Before you choose a crop or framing for a clip, `look {mode:"source", layer}` shows its whole
  frame with the crop; never guess where the subject is. The framing reference has the steps.
- After import, `look {mode:"source"}` (no layer) shows every clip and picture of the project,
  3 to 6 frames each; `layer:"<file name>"` one clip in 12 frames; `times:[…]` those file
  seconds. No FFmpeg contact sheets or frame grabs of your own.
- A video or sound over 100 MB imports as kino's own smaller copy (the answer says so): never
  re-encode it yourself.

## Cutting and skipping inside a clip

- `split_layer {layer, at}` cuts a video, audio or GIF layer at scene time `at`: the new piece
  "<name> 2" (the next free number) plays on from there in sync, right above it. Each piece
  keeps the animations that change what it shows; one crossing the cut stays on both.
- `split_layer {layer, from, to}` also skips the file between (dark frames, a stumble): the
  clip ends `to - from` s sooner. Its animations that start after `to` move that much earlier
  (a fade-out still ends with the clip); other layers stay where they are.
- Later ops of the same edit can name the new piece, like a copy from `duplicate_layers`
  ("<name> copy", or "<name> 2" with count).

- Skip 0.3 s of dark frames at 1.2 s, then turn the rest down:

```json
{"op":"add_layer","layerType":"video","name":"clip","properties":{"src":"/api/media/<clip>.mp4","mediaSourceDuration":4}}
{"op":"split_layer","layer":"clip","from":1.2,"to":1.5}
{"op":"update_layer","layer":"clip 2","properties":{"volume":0.5}}
```

## Clip speed: slow motion, reverse, choppy

- Video, audio and GIF layers take `mediaSpeed` (0.05–16), `mediaReverse:true`, and video/GIF
  `mediaFrameRate` (a choppy look). `mediaDuration` stays in scene seconds.
- Ramp the speed with animations `from`/`to` `{speed}` (or `preset:"speed"`). Picture, sound,
  beats and captions (`add_captions` `layerId`) all follow it; `check` does not call it motion.
- Sound: `mediaPitch:"keep"` (default) or `"follow"` (tape-like) at a constant speed; ramps always
  follow. Video `mediaInterpolation`: `"nearest"` (default), `"blend"` or slow `"flow"` (renders only;
  also smooths a screen recording that repeats frames, at any speed).
- On a cue, two moves do it for you (`at:"cue:<name>"`). **speed-ramp** `{layer, before?,
  after?, over?, land?}`: `before` (0.35) for `over` (0.6 s) into the cue, `after` (its own)
  from it, then back. A slow stretch makes the footage after it run late (the receipt says how
  much); `land:"moment"` moves `mediaOffset` so the cue keeps its file moment. A second ramp
  over the first is refused. **beat-repeat** `{layer, from?, length?, times? | count + every?,
  scaleStep?, flip?}`: one moment (`from`, file s; default what shows at `at`) replayed for
  `length` (0.3 s) on each time, as muted copies in the clip's direction and speed there.
  Reduced motion: no growth, flip or speed-up.
- Slow motion, 1× → 0.25× → 1× (slows from 1 s, stays at 0.25× until 2.5 s, 1× again at 3 s):

```json
{"op":"add_layer","layerType":"video","name":"clip","properties":{"src":"/api/media/<clip>.mp4","mediaSourceDuration":4,"mediaInterpolation":"blend"}}
{"op":"add_animation","layer":"clip","animation":{"kind":"custom","start":1,"duration":0.5,"easing":"smooth","from":{"speed":1},"to":{"speed":0.25}}}
{"op":"add_animation","layer":"clip","animation":{"kind":"custom","start":2.5,"duration":0.5,"easing":"smooth","from":{"speed":0.25},"to":{"speed":1}}}
```

## Syncing two clips of the same moment

- Two recordings of one moment (a phone filming someone use an app and the app's own screen
  recording; two cameras): show both at once, side by side or one small in a corner, and play
  them in step. One of them alone loses what the other shows.
- `sync_clips {layer, to}` matches the two files' sound (taps, beeps, words, steps) and moves
  `layer`'s Play (`mediaStart`, `mediaOffset`) so it plays in step with `to`, wherever `to` is.
  The receipt's `sync` gives `same` (one shared moment, as seconds into each file),
  `confidence` (0–1), `overlap` (seconds) and `inStep` (where both play). `search: 2` looks
  only within 2 s of how they line up now.
- Below 0.4 confidence, or with a file with no sound track, it changes nothing. Then tell the
  person the clips could not be matched by sound and ask for a sync point; or find one moment
  in both with `look {mode:"source", layer, t}` (a tap, a screen change) and send
  `at: {layer: <seconds into its file>, to: <seconds into to's file>}`. Never guess an offset.
- Before rendering, `look {mode:"sheet", from, to}` over `inStep`: each frame must show the
  same action in both clips.
- The link is kept by file (`clipLinks`), and files made by `isolate_voice` and `cut_out` inherit it: any later layer of either file is held to it by `out_of_sync`.

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"video","name":"screen","properties":{"src":"/api/media/<screen>.mp4","x":420,"y":0,"width":500,"height":1080,"mediaSourceDuration":20}},{"op":"add_layer","layerType":"video","name":"phone","properties":{"src":"/api/media/<phone>.mp4","x":940,"y":0,"width":608,"height":1080,"mediaSourceDuration":12}},{"op":"sync_clips","layer":"phone","to":"screen"}]}
{"tool":"look","mode":"sheet","from":3,"to":15}
```

## B-roll on the spoken word

- `place_broll {speech:"vo", clips:{"walk":"city at night","beans":"coffee beans"}}` plays each
  video clip where the voice says its words: in 0.2 s before the word (`lead`), out at the end
  of that sentence or a later one that says its words again (at least 1 s), never past the
  next clip. It starts on the first of the file's own shots long enough, one per clip.
- The receipt's `broll` lists each clip placed (times, the word, the shot) and each clip none of
  whose words is said (unchanged): give it words the voice says, not a description of the shot.
- Clean the voice first (`cut_speech` with `pauses:"natural"`, `"tight"` or `"fast"`: pauses over
  0.6, 0.35 or 0.2 s shrink to 0.4, 0.25 or 0.12 s); put the clips above the speaker's picture.
