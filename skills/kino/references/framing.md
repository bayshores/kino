# Framing footage

- Import lists a video's shots in file seconds (all: `library {topic:"media", search:"<id>"}`).
  A listed end is the next shot's first frame.
- Never guess the subject or center. At each shot you use, `look {mode:"source", layer, t}`
  shows the frame, a % grid, the crop and the result.
- `mark_subject {layer, t, box}`, box `[x, y, w, h]` in % of the source, x, y top-left; a face:
  the head. Mark each shot's start, middle and end (end − 0.05 s, not the listed end), every
  0.5 s where it moves over 10%. A mark beats a found face (an eye strip: mark the part).
- One video layer per shot, as below. `height` = H, `width` = H × w / h, `x` = W / 2 − box
  center % / 100 × `width`, from W − `width` to 0.
- Eyes near the top third; faces out of the bottom 707 and right 120 px of 1080×1920.
- A found face under 85% in frame (`crop_no_subject`) is an error: move, scale or mark. Also
  `narrow_window`, `shape_guess`, `ask_unmet`: each says the fix.

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
