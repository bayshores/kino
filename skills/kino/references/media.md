# Media

Images, video, audio and GIFs: importing and swapping a file, playing it faster, slower or
backwards, and B-roll on the spoken word. Syncing two clips is in the recording reference;
sound levels, ducking and voice separation in the sound references.

Contents: Importing and replacing files · Cutting and skipping inside a clip · Clip speed ·
B-roll on the spoken word

## Importing and replacing files

- `project {action:"import", file:"/absolute/path.png"}` (CLI: `kino project import /abs/clip.mp4`,
  or `path=`/`file=`) returns a `src` for an image, video or
  audio layer. A media layer draws only that `/api/media/…` address or a `data:` image; a file
  name, a path or a web address is refused, and so is an image, video or audio add_layer with no
  `src` (or an update_layer that clears it): import first, then add the layer. Video and audio
  also give the measured duration; the add_layer example sets it as `mediaSourceDuration`, so
  Play stops where the file ends.
- Video can be .mp4, .webm, .mov or .m4v. A .mov or .m4v (what iPhones record) is kept as an
  .mp4 with the same picture, copied and not encoded again: H.264 and HEVC import this way, and
  the new `src` ends in `.mp4`. Another picture codec (ProRes, for example) is refused with an
  ffmpeg line that converts it, unless the .mov has transparency (ProRes 4444 or any alpha
  pixel format): that imports as a transparent webm under its own name, and the answer adds
  `converted to transparent webm: W x H, N frames`.
- Log footage (flat, gray): a video tagged BT.2020 with no transfer curve, as Apple Log is, imports
  with `log:"apple-log"` in its add_layer example, which shows it as Rec.709. `log:null` shows the
  file as recorded. Set log yourself on a log clip the tags missed. replace_media sets log from the
  new file's import.
- A video's import answer also lists its shots in file seconds (`shots: 3: 1) 0–1.25 s …`),
  found with FFmpeg's scdet filter; a flash of a few frames is not a cut. If kino's FFmpeg is
  older than 5.1 or lacks the scdet or signalstats filter, it refuses the video and saves nothing.
- Importing a video also measures held frames, saved as `record.holds`: `repeated` (share of
  repeated frames), `frames` (the usual hold, 3 on 3s), `fps` and `stills` (the file's own held
  poses of 0.3 s or more). Drawn footage shows `drawn on 3s (...)` in its shots line. Slowed, keep
  `mediaInterpolation` `nearest` (whole drawings); `blend` lays two drawings over each other.
- `library {topic:"media", search?, page?}` lists imported files, 30 a page.
- Play: `mediaStart` (scene seconds it starts), `mediaOffset` (file seconds it starts from),
  `mediaDuration`. edit and inspect read trimStart or inPoint as mediaOffset, startTime as mediaStart.
- `replace_media {layer, mediaId}` (the imported file's name with its extension) swaps the file
  and keeps the layer's box, transform, effects and animations. Audio replaces only audio.
- Before you choose a crop for a clip, `look {mode:"source", layer}` shows its whole frame with
  the crop; never guess where the subject is. The framing reference has the steps.
- After import, `look {mode:"source"}` (no layer) shows every clip and picture of the project,
  3 to 6 frames each; `layer:"<file name>"` one clip in 12 frames (a found clip's shot code
  such as F4.13, a media id or a src works too: see and hear a clip no layer plays before the
  board, no add_layer; adds its sound line: heard lines, language, sounds, level; a read, so
  it works while a stop waits); `times:[…]` those file seconds. No FFmpeg contact sheets or
  frame grabs of your own.
- A video or sound over 100 MB imports as kino's smaller copy (the answer says so): never re-encode it.

## Cutting and skipping inside a clip

- `split_layer {layer, at}` cuts a video, audio or GIF layer at scene time `at`: the new piece
  "<name> 2" (the next free number) plays on from there in sync, right above it. Each piece
  keeps the animations that change what it shows; one crossing the cut stays on both.
- `split_layer {layer, from, to}` also skips the file between (dark frames, a stumble): the
  clip ends `to - from` s sooner. Its animations that start after `to` move that much earlier
  (a fade-out still ends with the clip); other layers stay where they are.
- Later ops of the same edit can name the new piece, like a copy from `duplicate_layers`
  ("<name> copy", or "<name> 2" with count).
- A receipt line `plays across a cut of its file` gives the cut's file second, the scene second
  it lands on and the trim (`mediaDuration`, or `mediaOffset`, `mediaStart` and `mediaDuration`)
  that ends the span before it: send that trim to drop the leaked frames. If both sides of the
  cut show for 0.25 s or more, it adds `, or in X s begins after it (...)`: pick the trim that
  keeps the shot you planned.

- Skip 0.3 s of dark frames at 1.2 s, then turn the rest down:

```json
{"op":"add_layer","layerType":"video","name":"clip","properties":{"src":"/api/media/<clip>.mp4","mediaSourceDuration":4}}
{"op":"split_layer","layer":"clip","from":1.2,"to":1.5}
{"op":"update_layer","layer":"clip 2","properties":{"volume":0.5}}
```

## Clip speed: slow motion, reverse, choppy

- Video, audio and GIF layers take `mediaSpeed` (0.05–16), `mediaReverse:true`, and video/GIF
  `mediaFrameRate` (a choppy look). `mediaDuration` stays in scene seconds. "On twos" for any
  layer or group (motion, effects, children): `frameRate:12`.
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

## B-roll on the spoken word

- `place_broll {speech:"vo", clips:{"walk":"city at night","beans":"coffee beans"}}` plays each
  video clip where the voice says its words: in 0.2 s before the word (`lead`), out at the end
  of that sentence or a later one that says its words again (at least 1 s), never past the
  next clip. It starts on the first of the file's own shots long enough, one per clip.
- The receipt's `broll` lists each clip placed (times, the word, the shot) and each clip none of
  whose words is said (unchanged): give it words the voice says, not a description of the shot.
- Clean the voice first (`cut_speech` with `pauses:"natural"`, `"tight"` or `"fast"`: pauses over
  0.6, 0.35 or 0.2 s shrink to 0.4, 0.25 or 0.12 s); put the clips above the speaker's picture.

A board shot as one video layer (W × H the video, `[x, y, w, h]` the crop): `height` = H × 100 / h,
`width` = `height` × the source's width / height, `x` = −x / 100 × `width`, `y` = −y / 100 ×
`height`, `mediaStart` = `cue`, `mediaOffset` = `in`, `mediaDuration` = `dur`, `mediaSpeed` = `speed`.
