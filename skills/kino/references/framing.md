# Framing footage

- The shape follows the footage unless the person named one.
- `look {mode:"source", layer, t}`, then `mark_subject {layer, t, box}` the subject you see: box
  `[x, y, w, h]` in % of the source, top-left; a face: the head. A deliberate strip adds
  `part:"eyes"`. An unlooked mark clears neither `narrow_window` nor `crop_no_subject`.
  Waive `narrow_window` or `head_cut_off` only on a looked-at layer.
  `ask_unmet`: `mark_subject {layer, t, shows:"<word>"}` (no box) at a looked-at second.
- Then `frame_shot {layer | layers}`: crops on the mark, a face or the saliency box, else a card.
  No face: keep 85% of that box; a mark inside it needs `part`.
- Mark each shot's start, middle and end (end − 0.05 s, never the end), every 0.5 s it moves over 10%.
  A mark beats a found face.
- `library {topic:"media", search:"<id>"}` lists a video's shots in file seconds.
  A listed end is the next shot's first frame.
- Eyes near the top third; faces out of the bottom 707 and right 120 px of 1080×1920.

A board shot as one video layer (W × H the video, `[x, y, w, h]` the crop): `height` = H × 100 / h,
`width` = `height` × the source's width / height, `x` = −x / 100 × `width`, `y` = −y / 100 ×
`height`, `mediaStart` = `cue`, `mediaOffset` = `in`, `mediaDuration` = `dur`, `mediaSpeed` = `speed`.

## Framing: crop footage to 9:16

One layer per shot; 1080×1920, 384×216 clip: `width` 3413 (`frame_shot` places it).

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"video","name":"shot1","properties":{"src":"/api/media/<clip>.mp4","x":-1167,"y":0,"width":3413,"height":1920,"mediaSourceDuration":4.417,"mediaDuration":1.25}},{"op":"add_layer","layerType":"video","name":"shot2","properties":{"src":"/api/media/<clip>.mp4","x":-1167,"y":0,"width":3413,"height":1920,"mediaSourceDuration":4.417,"mediaStart":1.25,"mediaOffset":1.25,"mediaDuration":2.083}}]}
{"tool":"look","mode":"source","layer":"shot1","t":0.6}
{"tool":"edit","ops":[{"op":"mark_subject","layer":"shot1","t":0.6,"box":[17,25,38,63]},{"op":"frame_shot","layer":"shot1"}]}
{"tool":"look","mode":"source","layer":"shot2","t":2.2}
{"tool":"edit","ops":[{"op":"mark_subject","layer":"shot2","t":2.2,"box":[40,12,17,22]},{"op":"frame_shot","layer":"shot2"}]}
{"tool":"look","mode":"sheet"}
```
