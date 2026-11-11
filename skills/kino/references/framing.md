# Framing footage

- `frame_shot {layer | layers}` first: crops on the mark or a found face, else the whole shot
  over a blurred copy. Faces come from a full check (pixels on): run one first.
- `library {topic:"media", search:"<id>"}` lists a video's shots in file seconds.
  A listed end is the next shot's first frame.
- To aim it or crop by hand: `look {mode:"source", layer, t}`, then `mark_subject {layer, t,
  box}`, box `[x, y, w, h]` in % of the source, top-left; a face: the head. Mark each shot's
  start, middle and end (end − 0.05 s, not the listed end), every 0.5 s it moves over 10%. A
  mark beats a found face.
- By hand, one layer per shot: `height` = H, `width` = H × w / h, `x` = W / 2 − box center
  % / 100 × `width`, from W − `width` to 0.
- Eyes near the top third; faces out of the bottom 707 and right 120 px of 1080×1920.
- `crop_no_subject` and `narrow_window` offer `frame_shot`; only a cut face on an unmoved layer
  is auto.

## Framing: crop footage to 9:16

1080×1920, 384×216 clip: `width` 3413; box centers 36%, 48.5%: `x` −689, −1115.

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"video","name":"shot1","properties":{"src":"/api/media/<clip>.mp4","x":-1167,"y":0,"width":3413,"height":1920,"mediaSourceDuration":4.417,"mediaDuration":1.25}},{"op":"add_layer","layerType":"video","name":"shot2","properties":{"src":"/api/media/<clip>.mp4","x":-1167,"y":0,"width":3413,"height":1920,"mediaSourceDuration":4.417,"mediaStart":1.25,"mediaOffset":1.25,"mediaDuration":2.083}}]}
{"tool":"look","mode":"source","layer":"shot1","t":0.6}
{"tool":"edit","ops":[{"op":"mark_subject","layer":"shot1","t":0.6,"box":[17,25,38,63]},{"op":"update_layer","layer":"shot1","properties":{"x":-689}}]}
{"tool":"look","mode":"source","layer":"shot2","t":2.2}
{"tool":"edit","ops":[{"op":"mark_subject","layer":"shot2","t":2.2,"box":[40,12,17,22]},{"op":"update_layer","layer":"shot2","properties":{"x":-1115}}]}
{"tool":"look","mode":"sheet"}
```
