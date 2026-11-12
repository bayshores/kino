# Light

Glow and bloom, light rays (god rays) and lens flares. Each is an effect you put on a layer.
The accent-hit and light-sweep moves use glow to light one word.

Contents: Stacked shadows and strokes, Light (glow, rays, flares, rim light, edge lines), Color as meaning, Cost and reduced motion.

Related effects that are not light: `vignette` and `grain` (finish), `duotone` and `tritone` (grade), `focus-band` (depth of field). Rim light: `glow` on a cut-out, or `light-rays`. Fields: `library {topic:"effects", name:"<effect>"}`.

## Stacked shadows and strokes

- A layer's `shadows` list draws more drop shadows after `shadow`, later ones on top: up to
  32 `{color, x?, y?, blur?, opacity?}`. Neon glow: one color at no offset, blur 4, 16, 40.
  Long shadow: hard copies stepping one way (2, 4, 6 ... px). Static; not in Lottie.
- `strokes` on text, shapes and paths: up to 16 `{color, width, align?, opacity?, dash?, join?,
  cap?, taper?, style?, glow?}` after `stroke`, later on top. Sticker: wide outside outlines
  first, `join:"round"`. Neon line or outline in one entry: `{color, style:"neon"}` (thin core 4,
  dim glow 24). `cap:"round"`; `taper:0.3` narrows both ends to points. Static; not in Lottie.

## Light: glow, rays and flares

- `glow` adds the layer's bright parts back on top, blurred. `threshold` picks how bright a part
  must be (0 with `softness` 0 glows all of it: neon on a title); `passes` 2–6 add wider blurs
  (deep glow); `color` with `colorMix` tints it (a red tint at the bright edges is halation).
  `mode:"behind"` puts the halo under the layer so its fill keeps its color.
- `rim-light` lights the edge of a layer's own shape (cut-out subject, text, shape) in one
  call: `color` "auto" (the layer's edge hue), `width` 8, `angle` "auto" or degrees (0 above),
  `spread` 20; `edge:"outside"` is a ring outline alone, `style:"lobes"` uneven electric lobes.
  `smooth` rounds a video matte's stair steps (auto: 4 px on video and image, 0 on text);
  `core` 0.3 mixes the line toward white (0 for a flat color line).
- `edge-lines` draws line art of a layer's picture: a line (`color`, `width` 3) wherever the
  brightness jumps. `threshold` 0.05 (lower finds fainter edges), `smooth` 1; the picture stays
  under, dimmed by `dim` 0.7 (no grade needed; a dark one before it hides the edges);
  `background:"transparent"` draws the lines alone. One subject's edge as a
  vector path to stroke, neon or draw on: `cut_out` with `output:"outline"` (`color`, `width`, `step`,
  `detail`), a path layer that follows the subject frame by frame.
- `light-rays` streaks light out from `centerX`/`centerY` (fractions of the layer's box).
  `source:"bright"` streaks the bright parts (sun through trees); `source:"behind"` puts a light
  of `lightSize` behind the layer, so its shapes cast shadows between the rays. `length` and
  `decay` set how far the rays reach and how fast they fade.
- `lens-flare` draws a lens flare whose light sits at `x`/`y` of the layer's box. `style` is
  `glint`, `anamorphic` (a long streak along `angle`), `rings` (ghosts on the line through
  the middle of the scene) or `streak` (one soft line across the picture, no ghosts: set `y`
  to an eye or mouth line). `ghosts` 0 turns reflections off; `softness`, `thickness`, `length`
  shape the streaks. Put it on a small layer with `x` 0.5, `y` 0.5 and it follows that
  layer; it fades out as the light leaves the scene.
- Light is drawn with its layer, so layers above cover it. To light several layers as one
  picture, group them and put the effect on the group.
- Animate any number with `from`: `from:{"strength":4}` to `parameters:{"strength":0}` on a
  cue is a flash; `from:{"x":-0.1}` to `x` 1.2 sweeps a flare across.
- A flash needs a cue that motivates it: light rising in the shot, a song seam or a top accent,
  never every beat. Over footage, `move impact-accent` with `kind:"flash"` lifts the shot's own
  exposure (a dark grade flashes in its own color, not white), sized by the cue's weight.
- `library {topic:"rules", name:"light"}` has every field and ten tested recipes: bloom,
  deep-glow, neon, halation, beat-flash, god-rays, light-behind-title, anamorphic-flare,
  sun-flare, flare-sweep.
- A glowing title with light behind it, a flare on the sun, and a flash on a cue:

```json
{"op":"add_layer","layerType":"rectangle","name":"sky","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#0E1420","radius":0}}
{"op":"add_layer","layerType":"ellipse","name":"sun","properties":{"x":1340,"y":160,"width":120,"height":120,"fill":"#FFF4DA"}}
{"op":"add_layer","layerType":"text","name":"title","properties":{"text":"Golden hour","x":360,"y":440,"width":1200,"height":200,"fontSize":150,"fontWeight":800,"fill":"#FFFFFF","textAlign":"center"}}
{"op":"add_animation","layer":"title","effect":"glow","parameters":{"strength":1.5,"radius":12,"passes":3,"threshold":0,"softness":0,"color":"#FFB070","colorMix":0.6}}
{"op":"add_animation","layer":"title","effect":"light-rays","parameters":{"source":"behind","lightSize":0.5,"length":0.5,"color":"#FFD9A0"}}
{"op":"add_animation","layer":"sun","effect":"lens-flare","parameters":{"style":"rings","x":0.5,"y":0.5}}
{"op":"set_cues","cues":[{"name":"hit","time":1}]}
{"op":"add_animation","layer":"title","effect":"glow","start":"cue:hit","duration":0.4,"from":{"strength":4},"parameters":{"strength":0,"radius":20,"threshold":0,"softness":0}}
```

## Color as meaning: accent-hit and light-sweep

Two moves (`move {name, layer, at}`) put one color on one thing for a moment, drawn on a copy
laid over your layer (`<id>-overlay`), so your layer keeps its own color and styled words. The
copy follows your layer's slides, rises and turns, and light-sweep's also its fades; start
accent-hit after a fade-in (a fade during the hit is refused). Color defaults to the brand
accent. Reduced motion: no glow, no sweep, just the color on and off.

- `accent-hit {layer, word?, color?, glow:30, hold:0.1, decay:0.2}`: the layer (or only `word`
  of a text layer) flashes to the color in 2 frames while a glow of `glow` px blooms, holds, and
  decays back in `decay` s (Apple's verbs). One hit per op; three a second is the flashing limit.
- `light-sweep {layer, color?, width:"2ch"}`: one band of the color with a soft halo crosses the
  letters once, left to right, at one speed (`dur`, default 1.2 s; a sign-off). `width`
  is `"2ch"`, `"30%"` of the layer or `"120px"`.

```json
{"op":"add_layer","layerType":"text","name":"line","properties":{"text":"careful, bicycle ahead.","x":360,"y":400,"width":1200,"height":120,"fontSize":80,"fill":"#FFFFFF","textAlign":"center"}}
{"op":"add_layer","layerType":"text","name":"wordmark","properties":{"text":"acme","x":760,"y":620,"width":400,"height":160,"fontSize":120,"fontWeight":700,"fill":"#FFFFFF","textAlign":"center"}}
{"op":"move","name":"accent-hit","layer":"line","word":"bicycle","color":"#FF4F9A","at":1}
{"op":"move","name":"light-sweep","layer":"wordmark","at":2}
```

## Cost, reduced motion and Lottie

- Light effects are SVG filters and shapes, drawn the same way in the dashboard and in exports.
  Rays cost the most (about 3× a glow at 1080p), then flares, then glow. See
  `library {topic:"rules", name:"light"}` for measured times.
- While rays show in a playing scene on a stage larger than 1280×720 device pixels, the
  dashboard draws the live picture at 1280×720 and enlarges it; the stage label says
  `drawn at 1280×720`, and its tooltip `drawn at 1280×720 while playing (light rays)`. With the
  stage zoomed to fill the window on a 2× Mac screen, one rays layer then plays at 30 fps
  (about 6 at full size); two rays layers that fill the frame about 25, three about 17. The
  paused picture and exports keep full resolution.
- People who turn on reduced motion see short Light animations (under 1 s, like a flash on a
  beat) drawn calmly in the dashboard preview. Exports are not changed.
- Lottie export draws Light effects as embedded image frames, like other effects, with a
  warning naming the layer. There the light is laid over the picture instead of added to it,
  so it is a little weaker on bright areas.
