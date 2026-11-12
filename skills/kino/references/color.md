# Color

## Color grading

- The Color effects (`curves`, `lut`, `hue-saturation`, `white-balance`, `color-wheels`, `keep-color`, `color-ranges`, `color-look`) go on with `add_animation` and stack in order; grade a group to grade its layers. `library {topic:"rules", name:"color"}` has their fields, the color space (sRGB 0–1, Rec.709 luma) and recipes: teal-orange, bleach-bypass, noir-keep-red.
- `exposure` and `saturation` run 0..4, 1 = unchanged (0.5 is half as bright, not half a stop up); text `"+0.5 stop"` or `"-0.7"` is a relative change.
- Also color: `duotone`, `tritone` (two or three colors by brightness), the finish `grain`, `vignette`; `focus-band` is depth of field (blur.md). `library {topic:"effects"}` lists all effects (add `name` for one's fields).
- A ready-made grade: `color-look` with `look` matte, ember, frost, ink, dusk, meadow, harbor or punch and `amount` 0 to 1 (e.g. `{look:"harbor", amount:0.6}`).
- A one-hue section grade (monochrome wash, tint, relight): `color-look` with `look:"section-grade"`, `hue` (HSL degrees, default 160), `keep:"skin"` (default; or `"color"` with `keepColor`), `keepAmount` 0.6, `bloom` 0.3, `blackLift` 0.04. It first stretches the shot's luma range (`normalize`, default on), so faces stay lit. `duotone` and `tritone` take the same `normalize`, `keep`, `keepColor`, `keepRange`, `keepAmount`; `tritone` maps each 8-bit luma level exactly (thresholds 0.02 apart render as set). Two-section grade: `{op:"add_animation",layer:"after",effect:"color-look",start:11.3,duration:3.7,parameters:{look:"section-grade",hue:330}}`; the shots before keep their hue.
- color-wheels gains share one scale: `gain` multiplies white; `gainRed`/`gainGreen`/`gainBlue` add to it for one channel (-4 to 4; gain 0.7 with gainBlue 0.8 is blue white at 1.5).
- One color only: `color-ranges` takes `<range>Hue`, `<range>Saturation`, `<range>Lightness` for red, orange, yellow, green, aqua, blue, purple, magenta (e.g. `blueHue:-20`), plus `highlights`, `shadows`.
- A LUT: import the .cube with `project {action:"import", file}`, then `effect:"lut"` with `parameters:{lut:"<src>"}`. `blendMode:"add"` on a layer is linear dodge.
- Mixed sources: `match_color` with `layers` (or `layer`) and `to` (the reference layer) grades each to that shot (effects "Color match" and "Color match saturation"; again replaces them).
- Dark footage: `match_references` lifts each shot darker than your saved references into their range (exposure only, `<layer>.match-ref`; compose does it unless `match:false`); by hand, `lift_dark` (below), not `gamma`; the `reference_range` fix names `lift_dark {layer}`.
- `match_references {made:true}` also places the made techniques your saved references' labels name (white flash, smear, duotone recolor, split-fields, particles, splatters, cut-outs) on song cues and subject shots, until the made share reaches the references' median; the receipt ends 'made share X of N moments before, Y of N after'. Its rules and placement: particles.md.
- One dark shot in one call: `lift_dark {layer, target?}` lifts it with a curve from its own tones, not a gamma wash: the black point stays, the mids rise to `target`, the highlights roll off. `target` and every mean are full range 0-255 (left out: the median of the scene's other pictures covering a fifth of the frame or more); the target line adds its video-range level (16-235), what a meter on the mp4 reads. Each shot is read on 6 frames of the whole edit at 240 px wide, inside its own box (letterbox bars do not count). A color effect on the shot or its group that moves its mean a level or more is named; the lift starts from the graded picture, so run `match_references` first. On drawn footage a flat dark fill rises too, only true black (16 or less) stays. The curve is `<layer>.lift`; from a 1 stop lift a small matched grain `<layer>.lift-grain` joins it (`grain:false` leaves it off); `remove:true` takes both off. Receipt: mean, contrast (p90-p10) and black before and after, beside a plain gamma's. A lift that draws more than a level off the target is fitted once more. Visible codec blocks get a deblock `<layer>.lift-deblock` first (the receipt gives the block step). The step is measured after the lift with the grain off, against a bar from up to 3 of the scene's bright shots (none: 0.25, a starting guess). Over the bar, the deblock is fitted again, up to 2 stronger tries, keeping the one that drew the least. Still over, the receipt names the largest lift that stays under it ('about +1.88 stops (mean about 29)'); the lift you asked for is still applied. The receipt also prints `shadow levels (distinct, darker half) X to Y` so you see banding before and after. Grain is one per source pixel (540p in 1080p: size 2); `reduced:true` (or a scene composed with reduced) keeps it still, the preview too.
- A teal-orange grade, then a full hue turn starting on a cue:

```json
{"op":"add_layer","layerType":"image","name":"footage","properties":{"src":"/api/media/<footage>.png","x":0,"y":0,"width":1920,"height":1080}}
{"op":"add_animation","layer":"footage","effect":"color-wheels","parameters":{"liftRed":-0.04,"liftGreen":0.01,"liftBlue":0.06,"gainRed":0.08,"gainGreen":0.02,"gainBlue":-0.1}}
{"op":"add_animation","layer":"footage","effect":"hue-saturation","parameters":{"saturation":1.15}}
{"op":"set_cues","cues":[{"name":"drop","time":2}]}
{"op":"add_animation","layer":"footage","effect":"hue-saturation","start":"cue:drop","duration":1,"from":{"hue":0},"parameters":{"hue":360}}
```

## Frame finish and letterbox

Two scene fields (`update_scene properties`), drawn above every layer in previews and renders; off until set.

- `finish {grain, blackLift, halation, vignette}`: each 0 to 1. Grain moves (the `grain` effect's amount: 0.15 is fine texture, 0.35 heavy film), blackLift raises the blacks to a soft gray, halation is a warm glow round bright spots, vignette darkens the corners. `soften` is diffusion (edges glow, fine lines soften, still in focus); `haze` a warm lifted veil. `finish:true` is a mild start (0.15, 0.04, 0.2, 0.3, soften 0.5, no haze). `false` removes it.
- `letterbox`: a width : height ratio (2.35 is the wide cinema shape, 1.2 to 6), black bars top and bottom, each (height - width / ratio) / 2 tall. `false` removes it.
- `aboveLetterbox:true` on a root layer draws it over the bars (type that crosses into them).
- Lottie leaves both out and warns (`lottie-finish-omitted`); video, GIF and PNG keep them.
- The finish sits above the picture and its effects, ungraded. Saved references do not measure bars or grain yet: read `look {mode:"source"}` frames and match by eye.

```json
{"op":"add_layer","layerType":"rectangle","name":"shot","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#3A4A5C"}}
{"op":"add_layer","layerType":"text","name":"title","properties":{"text":"NIGHT SHIFT","fontSize":160,"fontWeight":900,"fill":"#FFFFFF","x":300,"y":470,"aboveLetterbox":true}}
{"op":"update_scene","properties":{"finish":{"grain":0.25,"blackLift":0.05,"halation":0.3,"vignette":0.6},"letterbox":2.35}}
```

## Filters

- `color_filter {layer | layers, filter, strength?}`: one named look, as one or two Color effects named "Filter <name>": warm, cool, film, teal-orange, faded, vivid, mono, bleach-bypass. Another `color_filter` replaces it, `filter:"none"` removes it; `strength` 0 to 1 tones it down.

```json
{"op":"add_layer","layerType":"rectangle","name":"card","properties":{"x":0,"y":0,"width":400,"height":300,"fill":"#C8935A"}}
{"op":"color_filter","layer":"card","filter":"film","strength":0.7}
```

## Blocks under a punch-in

A punch-in on small footage (`soft_upscale` over 1.3x) can show the source's codec blocks. The finding states the block step on the source grid (measured with grain off, which hides blocks). When it names a deblock, call `{"op":"deblock_upscaled","layer":"clip"}` (`ratio?`, `scene?`, `remove?`): it adds `clip.upscale-deblock` where the step is 1.5x the steps inside, and prints the step before and after. Otherwise choose a smaller scale or a sharper file.

## Changing an effect

An effect's settings are its `to` (end values) and `from` (start values), not fields beside `start` and `duration`. `update_animation` with `to` changes the settings it names and keeps the others:

```json
{"op":"add_layer","layerType":"rectangle","name":"plate","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#556070"}}
{"op":"add_animation","layer":"plate","effect":"color-wheels","parameters":{"gamma":0.9,"gainBlue":0.05}}
```

Later (`plate.effect` names it once saved; with several effects use its code, such as `A1`, or `plate.color-wheels`):

```json
{"op":"update_animation","animation":"plate.effect","properties":{"to":{"gamma":0.6}}}
```

## Gradient fills

A layer's `fill` can be a gradient: `{type:"linear", angle, stops:[{offset, color}]}` (angle 90 runs top to bottom), or `{type:"radial", stops}`, a circle as wide as the box (give it a square box).
