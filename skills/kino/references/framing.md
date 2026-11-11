# Framing footage

- `frame {layer}` on a hand-placed video layer: kino's layout, a found face leads, else a card
  over its blur. `check {fix:"auto"}` runs it on cut faces.
- Import lists a video's shots in file seconds (`library {topic:"media", search:"<id>"}`); a
  listed end is the next shot's first frame.
- Never guess the subject or center. `look {mode:"source", layer, t}` shows the frame, % grid, crop.
- `mark_subject {layer, t, box}`, box `[x, y, w, h]` in % of the source, x, y top-left (a face:
  the head). Mark each shot's start, middle, end (end − 0.05 s), every 0.5 s it moves over 10%.
  A mark beats a found face.
- By hand, a layer per shot: `height` = H, `width` = H × w / h, `x` = W / 2 − box center % / 100
  × `width`, from W − `width` to 0.
- Eyes near the top third; faces off the bottom 707 and right 120 px of 1080×1920 (unverified).
- `shape_guess`: the video's shape is not most footage's and `plays_on` is not the person's
  words: match the footage, or save `plays_on` by "you" with their quote (a vertical edit stays
  possible). `narrow_window`: a window under 40% of its file, no face found: `look`, or `frame`.
- `ask_unmet`: the word most titles about the person's subject share is in no shot or found clip
  title, and they gave no footage: search it, or waive the scene naming the word.

## Framing: crop footage to 9:16

1080×1920, 384×216 clip: `width` 3413; box center 36%: `x` −689.

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"video","name":"shot1","properties":{"src":"/api/media/<clip>.mp4","x":-1167,"y":0,"width":3413,"height":1920,"mediaDuration":1.25}}]}
{"tool":"look","mode":"source","layer":"shot1","t":0.6}
{"tool":"edit","ops":[{"op":"mark_subject","layer":"shot1","t":0.6,"box":[17,25,38,63]},{"op":"update_layer","layer":"shot1","properties":{"x":-689}}]}
{"tool":"look","mode":"sheet"}
```
