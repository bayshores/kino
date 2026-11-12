# Color

Grading a picture: curves, LUTs, hue and saturation, white balance, lift/gamma/gain, keeping
or changing one color, plus the `add` blend mode.

## Color grading

- The Color effects (`curves`, `lut`, `hue-saturation`, `white-balance`, `color-wheels`,
  `keep-color`, `color-ranges`, `color-look`) go on with `add_animation` and stack in order; grade a group to
  grade its layers.
  `library {topic:"rules", name:"color"}` has their fields, the color space (sRGB 0–1, Rec.709
  luma) and recipes: teal-orange, bleach-bypass, noir-keep-red.
- Not in that list but also color: `duotone` and `tritone` (two or three colors by brightness), and the finish `grain` and `vignette`; `focus-band` is depth of field (blur.md). `library {topic:"effects"}` lists all effects, `{topic:"effects", name}` gives one's fields.
- A ready-made grade: `color-look` with `look` matte, ember, frost, ink, dusk, meadow, harbor or
  punch and `amount` 0 to 1 (e.g. `{look:"harbor", amount:0.6}`).
- A one-hue section grade (monochrome wash, tint, relight) in one call: `color-look` with
  `look:"section-grade"`, `hue` (HSL degrees, default 160), `keep:"skin"` (default; or `"color"`
  with `keepColor`), `keepAmount` 0.6, `bloom` 0.3, `blackLift` 0.04. It stretches the shot's own
  luma range first (`normalize`, default on), so faces stay lit instead of one flat tone.
  `duotone` and `tritone` take the same `normalize`, `keep`, `keepColor`, `keepRange`, `keepAmount`.
- color-wheels gains share one scale: `gain` multiplies white; `gainRed`/`gainGreen`/`gainBlue`
  add to it for one channel (-4 to 4; gain 0.7 with gainBlue 0.8 is blue white at 1.5).
- One color only: `color-ranges` takes `<range>Hue`, `<range>Saturation`, `<range>Lightness` for red,
  orange, yellow, green, aqua, blue, purple, magenta (e.g. `blueHue:-20`), plus `highlights`, `shadows`.
- A LUT: import the .cube with `project {action:"import", file}`, then `effect:"lut"` with
  `parameters:{lut:"<src>"}`. `blendMode:"add"` on a layer is linear dodge.
- Mixed sources: `match_color` with `layers` (or `layer`) and `to` (the reference layer) grades each
  to that shot (effects "Color match" and "Color match saturation"; again replaces them).
- Dark footage: `look frame` at its darkest moment first, and lift it (`gamma`, `lift`) before
  adding contrast. Add one grade at a time and look again: stacked grades can crush it to black.
- A teal-orange grade, then a full hue turn starting on a cue:

```json
{"op":"add_layer","layerType":"image","name":"footage","properties":{"src":"/api/media/<footage>.png","x":0,"y":0,"width":1920,"height":1080}}
{"op":"add_animation","layer":"footage","effect":"color-wheels","parameters":{"liftRed":-0.04,"liftGreen":0.01,"liftBlue":0.06,"gainRed":0.08,"gainGreen":0.02,"gainBlue":-0.1}}
{"op":"add_animation","layer":"footage","effect":"hue-saturation","parameters":{"saturation":1.15}}
{"op":"set_cues","cues":[{"name":"drop","time":2}]}
{"op":"add_animation","layer":"footage","effect":"hue-saturation","start":"cue:drop","duration":1,"from":{"hue":0},"parameters":{"hue":360}}
```

## Filters

- `color_filter {layer | layers, filter, strength?}`: one named look, as one or two Color effects
  named "Filter <name>": warm, cool, film, teal-orange, faded, vivid, mono, bleach-bypass. Another
  `color_filter` replaces it, `filter:"none"` removes it; `strength` 0 to 1 tones it down.

```json
{"op":"add_layer","layerType":"rectangle","name":"card","properties":{"x":0,"y":0,"width":400,"height":300,"fill":"#C8935A"}}
{"op":"color_filter","layer":"card","filter":"film","strength":0.7}
```

## Changing an effect

An effect's settings are its `to` (the values it ends at) and `from` (where it starts), not
fields beside `start` and `duration`. `update_animation` with `to` changes the settings it
names and keeps the others:

```json
{"op":"add_layer","layerType":"rectangle","name":"plate","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#556070"}}
{"op":"add_animation","layer":"plate","effect":"color-wheels","parameters":{"gamma":0.9,"gainBlue":0.05}}
```

Then, in a later edit (`plate.effect` names it once saved; on a layer with several effects use
its code, such as `A1`, or `plate.color-wheels`):

```json
{"op":"update_animation","animation":"plate.effect","properties":{"to":{"gamma":0.6}}}
```

## Gradient fills

A layer's `fill` can be a gradient: `{type:"linear", angle, stops:[{offset, color}]}` (angle
90 runs top to bottom), or `{type:"radial", stops}`, a circle as wide as the box (give it a
square box).
