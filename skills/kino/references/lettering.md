# Lettering

Worn type, a word on a made panel, a word behind a subject, type beside one, fonts like a reference. Fields: `library {topic:"type-material"}` and `library {topic:"moves", name:"word-panel"}`.

## Material

- `update_layer {layer, properties:{material:{wear:{amount, seed, size}, texture:{kind, amount, seed, color, size}, print:{x, y, color, opacity}}}}` gives worn, textured or misprinted lettering. Nothing is applied by default; each part is optional and they combine.
- `wear` erodes the letter edges (at the very edge a share `amount` of the paint goes, less deeper in); a new `seed` gives a new pattern.
- `texture.kind` is `grain`, `brush`, `crackle` or `halftone`, drawn only inside the letters.
- `print` is an offset second copy drawn under the letters and their outside strokes, worn along its own edges; a layer blur or shadow keeps it.
- A material stays locked to the letters under scale, motion and turn, and draws the same on letters animated one by one as on the still word.
- Check's contrast measures the fill color, not the texture color: keep a dark texture on a light fill (or the reverse) at an amount that leaves the letters readable.
- `amount` 0 means no material; `material:null` removes it; Lottie export refuses it.
- Shorthands: `wear:0.6`, `texture:"crackle"`, `print:"#FF3FA4"`. A `texture` with no `color` follows the fill (white on a dark fill, black on a light one), printed as a starting guess. A `print` with no `x` and `y` is offset 0.05 and 0.03 of `fontSize` (12 and 7 px on a 240 px word); give one and the other is 0, and `x:0,y:0` draws none. The edit's notes print the material at the layer's size, guessed sizes marked.

```json
{"op":"add_layer","layerType":"text","name":"worn","properties":{"text":"RUN","x":260,"y":300,"width":1400,"height":480,"fontSize":400,"fontWeight":900,"fill":"#ffffff","textAlign":"center"}}
{"op":"update_layer","layer":"worn","properties":{"material":{"wear":{"amount":0.6,"seed":4},"texture":{"kind":"grain","amount":0.5,"color":"#5A0A0A"},"print":{"x":14,"y":10,"color":"#FFD400"}}}}
```

## A word on a panel

- `move {name:"word-panel", textLayer, at, shape, turn, pad, color, ink, layer, subject, enter}` sets your text layer on a made panel and turns both together as one group (`turn`). `shape` is `box`, `sign` (a border) or `strip` (across the frame).
- The panel is sized from the word's laid-out box plus `pad`. `color:"auto"` takes the hue measured on `layer`'s picture, else the look's accent; `ink` is the color with the most contrast on it. The notes print the size, pad, turn and where each color came from.
- The word is fitted to its drawn width and centered in the box or sign (the notes print the inset). A strip runs across the whole frame; the word keeps its own place along it. A text box narrower than its widest word is widened in the panel's copy so the word never breaks (the notes name the word and both widths).
- Your text layer, with no show or hide steps of its own, is hidden from 0 s, so the word shows only with its panel: do not hide it by hand. Deleting the move's group, or `remove:true`, takes that hide away.
- Left out, each `turn` is its own seed pick (3 to 9 degrees either way) per word-panel in the scene; the notes count the placements sharing its turn, size and side. Send `turn` to choose.
- With `layer` a clip, the notes give the share of its face or head box the panel covers at the worst moment, and of its eye band (25 to 50% down the box, a guess), with the second, for your mark first and then the scan. `mark_subject` with `part:"face"` before placing names your own box.
- With no `dur` the panel leaves when `layer` stops showing. `at` takes a song cue (`"cue:drop"`).
- `enter:"slam"` lands from 1.25x about the panel's center; `"cut"` (default) is on at once. Reduced motion fades it on.

```json
{"op":"add_layer","layerType":"rectangle","name":"shot","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#E76F51"}}
{"op":"add_layer","layerType":"text","name":"word","properties":{"text":"RUN","x":260,"y":300,"width":1400,"height":480,"fontSize":300,"fontWeight":900,"fill":"#ffffff","textAlign":"center"}}
{"op":"move","name":"word-panel","textLayer":"word","layer":"shot","shape":"sign","at":0.5}
```

## A word behind a subject

- Add `subject:"<clip>"` (a cut-out, or the plain clip: the cut-out is made or reused) and the panel sits under the subject in one call: `move {name:"word-panel", textLayer:"word", layer:"<clip>", subject:"<clip>", at:1}`.
- The notes give each letter's worst covered share over the move's span and name the letters over 60% with the second: move or shrink the word there.

## Type beside a subject

`place {layers:["word"], around:"<cut-out>"}` (or a shot, or `"subject"`: the marked subject of the shot under the text) sets type in the free room, shrunk to fit, clear of the subject for the whole time the text shows (up to 24 sampled seconds). `around` is required. `side` is left, right, above, below or split. With no `side` it keeps the type largest, then moves it least: text already clear stays put. `split` sets one line in two parts at a word gap, the second a new layer `<name> 2`. `follow:true` instead moves it with the subject on a pin path (track "around"), the shortest move clear of it at every moment, same size. A face mark, or a face kino found, counts as a person down to the picture's bottom, so no text goes below it. The receipt prints the subject box with the second it was measured at, the letter share inside it at the worst moment before and after, the room on each side, and says when no spot is clear for the whole hold; `type_covered` reads the same box. It prints `size A → B px` for a shrink or a split; when that leaves the type under the type size check's floor (about 3% of the frame's shorter side), it names the side with the most room and one edit that restores the words and size, then places them there.

## Fonts like a reference

`library {topic:"fonts", like:"yt:<id>", t, region:[x,y,w,h]}` ranks faces by the measured letters of a saved reference. Pass `t` at a moment with large lettering, plus `region`: a 640 px still within 0.1 s of `t` is measured, else the 240 px strip frame. Letters under 24 px rank on width and shape only, and the answer says so. Each face line reads `face vs ref: weight, width, contrast, upright or script`.
