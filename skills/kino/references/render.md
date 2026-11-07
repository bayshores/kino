# Render

Videos and stills come from `render` (the person sees each job in the dashboard). `out` must be
an absolute folder (the `kino` command resolves a relative one or `~` for you).

## Render ladder and queue

- `render {action:"start", quality:"final", out, wait:true}` once `check` shows 0 errors and
  `look {mode:"review"}` has shown every moment (else `review_needed`). With `wait:true` it
  answers when the file is checked; if the render takes longer, it says it is still running:
  then `render {action:"wait"}` until it returns the file. Use `quality:"draft"` only
  if you need to see real motion.
- Past the build, status (and the answer to the last stop) says `to final: 1) … N) render final`,
  and a refused final names every gate still open. Plan them all at once, in that order
  (stops, intents, viewer, critic, fixes, check, review, versus): a fix redoes what comes after.
- `quality:"draft"` uses half each scene dimension at 30fps (even video sizes); `fps` sets another
  rate up to 30 (the footage's 24 or 25). The person watches drafts, so never drop them to 15.
  `quality:"final"` uses full dimensions and `fps` (default 30; 23.976, 29.97 and 59.94 for
  editing apps and broadcast, or `options:{fps:"30000/1001"}`), `motionBlur:0.5` (two shutter
  samples) and `dither:true`. Override with `motionBlur:0`, `dither:false` for the original
  appearance. Unwaived errors (and `signature_missing`) block final, and so do the video's open stops (`stops_open`:
  ask them in order, or the person allows them in settings; drafts still render). Saved
  reduced-motion choices stay in effect.
- Motion blur comes from how layers move while the shutter is open. By default each frame
  draws as many samples as its fastest move needs for the copies to sit at most 8 px apart
  (2 to 16), so a fast move smears evenly; `motionSamples:2..16` fixes the count (2 shows a
  fast move as two copies). Each sample is one more drawing of a moving frame (8 samples: about
  8 times the render time there; still frames are drawn once). Footage (blend and flow clips
  too) keeps the picture of the frame's own time, as `look` shows it. The dashboard, its cached
  playback and `look` show a preview of the blur; a final png shows the real one:

```json
{"action":"start","quality":"final","format":"png","options":{"time":1.2,"shutterAngle":180,"motionSamples":8}}
```
- `scene:"all"` exports up to 20 scenes as separate files. Unchanged scenes reuse checked
  segments, including after app restart. `wait` reports `cachedScenes`, `redrawnScenes`, and
  `files` with checks; reused files report zero newly rendered frames. Use the returned job ID:

```json
{"action":"start","scene":"all","quality":"draft","format":"mp4"}
{"action":"queue"}
{"action":"wait","job":"R1"}
```

- `queue` lists recent jobs; `status` shows one; `cancel` stops work (a job that already
  finished answers `Nothing to cancel` with its saved files). Two exports run at once. Restart
  interrupted jobs to reuse finished scenes; job history persists.
- Formats: mp4, webm, mov, gif, png, apng, png-sequence (ZIP), lottie (native vector canvas;
  no blur/dither). `options` passes existing settings such as transparent, profile, loop, GIF
  quality, PNG time, and imageDPIRatio.
- MP4 only: `options:{videoEncoder, videoQuality}` replace the person's export defaults for
  one render. `videoEncoder` is "auto", "software" (libx264) or a hardware family:
  "videotoolbox" (Mac), "nvenc", "qsv", "amf" or "vaapi". A named encoder that does not work on
  this computer is an error that lists the others that do. One that works here but not at this
  file's size encodes it with libx264, and `wait` says why, for example `encoded with libx264
  (NVENC cannot encode frames this small: 128x72)` for a small draft (NVENC needs at least
  145x49). `videoQuality` "small" halves the bitrate and "high" doubles it ("standard" is
  24 Mbps at 720p and up, 12 Mbps below):

```json
{"action":"start","quality":"draft","format":"mp4","options":{"duration":1,"videoEncoder":"software","videoQuality":"high"}}
```

- The graphics card, frames at once and memory to leave free are the person's dashboard
  settings (rendering); you cannot change them. `wait` says what drew each file and what
  encoded it, such as `drawn on Apple M3 Pro (Metal) (graphics card), 1 frame at once; encoded
  with h264_videotoolbox, standard quality` (frames at once: the most workers that drew at the
  same time; one started in place of a crashed worker does not add). A `graphics-card-not-used`
  warning means the processor drew although this computer has a card: tell the person
  (docs/running.md says how).
- File checks cover dimensions, frames, duration, codec, audio-stream offset and sound peak
  where supported. A master limiter keeps exported sound at or under -1 dBTP true peak,
  measured after AAC or Opus encoding. Before it, every mp4, webm or mov (drafts too) brings the
  whole mix (after ducking) to a loudness target: `options:{loudness:"web"}` (-14 LUFS, default),
  `"podcast"` (-16), `"broadcast"` (-23) or `"off"`. `audioLoudness` warns 2 LU off target.
  `wait` shows `sound: -14 LUFS (target -14 web), range 4.2 LU, true peak -1.1 dBTP`. Without a
  target, a mix that would have clipped gets a warning naming the moment and the sounds playing
  then: lower those volumes and render again.
- Final video audits compare each decoded frame with its renderer frame and measure audio;
  unsupported checks are explicit. GIF can merge frames; PNG ZIPs have no timing metadata.
  Details: `library {topic:"rules",name:"render"}`.
- It also compares each decoded frame with the renderer frames just before and after it.
  When 8 or more frames in a row look like a neighbour, the file runs a frame early or late
  (a frame was dropped or repeated) and the render fails, naming the first and last frame.
  A picture that does not change cannot show a shift. That is an encoding fault, not your scene: render again; if it fails again,
  report it with the error message and the scene. When the message says the encoder may have
  dropped detail, render again with the `videoQuality` or `videoEncoder` it names.

## Exports through the workspace

- `project {action:"manage", id, options:{resource:"exports", action:"start", quality:"draft",
  options:{format:"png", time:1}}}`, then `wait {batch}`, adds ZIPs and cancel/resume of a
  batch. A draft export is half size at 30fps (fps up to 30); `quality:"final"` uses the size and fps in
  `options`. Its `out` must be an absolute folder.
- A png-sequence never replaces a file it did not write: it takes the next free name.
- Big final exports may answer `awaiting_approval`, as `render` does.
