# Lettering

Worn type, a word on a made panel, a word behind a subject. Fields: `library {topic:"type-material"}` and `library {topic:"moves", name:"word-panel"}`.

## Material

- `update_layer {layer, properties:{material:{wear:{amount, seed, size}, texture:{kind, amount, seed, color, size}, print:{x, y, color, opacity}}}}` gives worn, textured or misprinted lettering. Nothing is applied by default; each part is optional and they combine.
- `wear` erodes the letter edges (at the very edge a share `amount` of the paint goes, less deeper in); a new `seed` gives a new pattern.
- `texture.kind` is `grain`, `brush`, `crackle` or `halftone`, drawn only inside the letters.
- `print` is an offset second copy drawn under the letters and their outside strokes, worn along its own edges; a layer blur or shadow keeps it.
- A material stays locked to the letters under scale, motion and turn, and draws the same on letters animated one by one as on the still word.
- Check's contrast measures the fill color, not the texture color: keep a dark texture on a light fill (or the reverse) at an amount that leaves the letters readable.
- `amount` 0 means no material; `material:null` removes it; Lottie export refuses it.

```json
{"op":"add_layer","layerType":"text","name":"worn","properties":{"text":"RUN","x":260,"y":300,"width":1400,"height":480,"fontSize":400,"fontWeight":900,"fill":"#ffffff","textAlign":"center"}}
{"op":"update_layer","layer":"worn","properties":{"material":{"wear":{"amount":0.6,"seed":4},"texture":{"kind":"grain","amount":0.5,"color":"#5A0A0A"},"print":{"x":14,"y":10,"color":"#FFD400"}}}}
```

## A word on a panel

- `move {name:"word-panel", textLayer, at, shape, turn, pad, color, ink, layer, subject, enter}` sets your text layer on a made panel and turns both together as one group (`turn`). `shape` is `box`, `sign` (a border) or `strip` (across the frame).
- The panel is sized from the word's laid-out box plus `pad`. `color:"auto"` takes the hue measured on `layer`'s picture, else the look's accent; `ink` is the color with the most contrast on it. The notes print the size, pad, turn and where each color came from.
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
