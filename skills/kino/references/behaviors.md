# Behaviors: keys, loop, wiggle and copies

No expressions: an in, out, custom or effect animation takes a `behavior`, a custom one `keys`, and
`duplicate_layers` makes many real copies. Every result is a pure function of time and seed, so
check, look and Lottie (baked to keyframes) see exactly what plays.

- `animation:{kind:"custom", start, duration, keys:[{t:0, value:{x:0, opacity:0}}, {t:0.4,
  value:{x:300, opacity:1}, ease:"overshoot"}, {t:1, value:{x:260, opacity:1}}]}`: 3 to 64 keys,
  `t` a share 0..1 of the duration, rising; every `value` names the same keys (any animatable
  one: effectPreset, rotateX...). `ease` shapes the step to the next key (default the
  animation's easing; `"steps"` counts by the animation's intensity). Before the first key it holds the first value, after the last the last;
  from and to become the first and last value. Not with motionPath, scatter, range, fromCurrent.
  `add_animation {layer, start, duration, keys}` works too; the receipt's `keys` counts them,
  inspect lists them. Change them with `update_animation properties:{keys}`, not from/to.
- `behavior:{loop:{mode:"cycle"}}` plays the animation again and again from its start until the
  scene ends (inside a component: its source scene's end); `"pingpong"` plays it forward then
  backward. A looping layer counts as perpetual, so a constant-speed spin may be `linear`.
  Lottie holds each cycle restart (a jump, not a slide back).
- `behavior:{wiggle:{amount, rate?:2, seed?:0, decay?:0}}` adds smooth random drift to the numbers the
  animation changes: `amount` in each property's own units (one number for all of them, or
  `{rotation:4, y:6}` for some). One number with `scaleX`, `scaleY` or `opacity` beside other
  keys is refused (8 is 800%): give one per key. A key only in `amount` wiggles in place.
  Speed, volume and lowpass can't loop or wiggle.
  `rate` is about how many drifts a second; another `seed` gives another pattern. It layers three
  octaves (finer, weaker shakes on the drift), so it reads hand-held. The drift eases from 0 at
  the animation's start and back at its end, so nothing jumps, and a looping wiggle repeats seamlessly.
  `decay` (0-100 per second) fades it as e^(-decay x seconds): a shake that dies down.
- More offsets, added to the animated value (combine freely; `amount` like wiggle's; held after the
  animation ends): `oscillate:{amount, period?:1 s, phase?:0..1, wave?:"sine"|"triangle"|"square"|"saw", decay?:0 per s}`;
  `ramp:{to, from?:0, start?:0 s, duration?:to the end, ease?:"linear"}` (to/from one number or
  `{y:40}`; its seconds stretch when the animation does); `randomize:{amount, rate?:2 a s, seed?:0, mode?:"smooth"|"stepped"}` (random values,
  no ease-in: stepped jumps, a hand-drawn boil). An effect takes them on named settings
  (`behavior:{oscillate:{amount:{hue:30}}}`) but can't loop.
- `overshoot:{bounce?:0.3 (0..1), settle?:0.6 s}`: after the end each number swings past its end
  value (first swing bounce times its last move, keys: last step; motion paths too) and is back
  within 1% by settle. It leaves at the move's end speed: after ease-out it eases out then swings. `follow:{layer, lag?:0.1 s, scale?:1, offset?:0, property?}` adds the
  leader's move since its saved value, lag seconds late (`offset:{x:0, y:0}` names the keys; chain
  layers for a trail; edits to the leader update it). `audio:{layer, band?:"all"|"low"|"mid"|"high",
  amount, smoothing?:0.15 s}` adds amount times the sound's level 0..1 (1 at its loudest), rising at
  once, falling over smoothing (effects too). None of the three loop; overshoot and follow not on effects.
- `duplicate_layers {layers, count, layout?, spacing?, columns?, radius?, stagger?}` makes up to 50
  copies named "<name> 2", "<name> 3"…: `line` in a row (`spacing:{x, y}`, default the box
  width plus 24), `grid` in rows of `columns`, `radial` a ring of count + 1 with the original at
  12 o'clock (`radius`). `stagger` starts each copy's animations that many seconds later. A field
  the layout does not use is refused; numbers already taken are skipped.
- duplicate_layers `at:[times or cues]` (or one time) puts copy n at the n-th time, in place; times
  inside the scene. The original is read at its Show; each copy's Show, Hide and media time move by the same delay. Whole-scene grades stay whole. A recorded move's flash stays on the original unless `withMoves:true`.
- A copy fully under a full-frame layer above it is raised above that layer and the receipt names it; when raising it would cover words, it stays and the receipt gives the `move_layers` call.
- `vary` steps a field over the places in time order: {op:"duplicate_layers",layers:["ring"],at:["cue:drop",11.3],vary:{scaleX:[0.4,1.6],scaleY:[0.4,1.6]}}; or one per place: text:["1","2","3"]

## Pivot and skew

- `anchor:[x, y]` (layer property, percent of the box, default 50 50) is the point rotation,
  scale and skew turn about. add_animation's top-level `anchor` (`[0, 100]` or `"top-left"`) on a
  rotate or scale sets it: a door swing turns about `"left"`, a bar grows from `"bottom"`. On a
  Resize it is the Resize's own anchor; later, change the pivot with update_layer.
- `skewX`, `skewY` (degrees) slant a layer and animate like any value.

## Examples

A badge that spins forever, a floating card, and a row of dots that pop in one after another:

```json
{"op":"add_layer","layerType":"rectangle","name":"badge","properties":{"x":1600,"y":120,"width":160,"height":160,"fill":"#ffcc00","radius":32},"animations":[{"kind":"custom","name":"Spin","start":0,"duration":4,"easing":"linear","from":{"rotation":0},"to":{"rotation":360},"behavior":{"loop":{"mode":"cycle"}}}]}
{"op":"add_layer","layerType":"rectangle","name":"card","properties":{"x":660,"y":340,"width":600,"height":400,"fill":"#1d2540","radius":24},"animations":[{"kind":"custom","name":"Float","start":0,"duration":6,"from":{},"to":{},"behavior":{"wiggle":{"amount":{"y":10,"rotation":1.5},"rate":1,"seed":3}}}]}
{"op":"add_layer","layerType":"ellipse","name":"dot","properties":{"x":700,"y":860,"width":40,"height":40,"fill":"#7cf0c8"},"animations":[{"preset":"preset-grow","start":0.4,"duration":0.4,"easing":"overshoot"},{"preset":"preset-fade","start":0.4,"duration":0.4}]}
{"op":"duplicate_layers","layers":["dot"],"count":7,"layout":"line","spacing":{"x":72,"y":0},"stagger":0.08}
```

## Trim paths and dashes

Shapes, paths: `strokeStart`, `strokeEnd` (0-1 a contour), `strokeOffset` (turns), `dash`
([on, off, …] px), `dashOffset` (px); modifiers `roundCorners`, `bloatAmount`, `twistAngle`,
`zigzagSize` (`zigzagCount`, `zigzagPoints`), `offsetAmount` (`offsetJoin`), `roughenSize` (brush edge); animate.
`trim` (or `draw-on`) draws `strokeEnd` from 0.

```json
{"op":"add_layer","layerType":"path","name":"underline","properties":{"x":560,"y":700,"width":800,"height":40,"path":"M0 20 C260 0 540 40 800 20","fillEnabled":false,"stroke":"#FFD166","strokeWidth":10}}
{"op":"add_layer","layerType":"rectangle","name":"frame","properties":{"x":460,"y":240,"width":1000,"height":400,"radius":24,"fillEnabled":false,"stroke":"#FFFFFF","strokeWidth":4,"dash":[18,12]}}
{"op":"move","name":"draw-on","layer":"underline","at":0.5}
{"op":"add_animation","layer":"frame","preset":"trim","start":0.2,"duration":1}
{"op":"add_animation","layer":"frame","animation":{"kind":"custom","start":1.2,"duration":2,"easing":"linear","from":{"dashOffset":0},"to":{"dashOffset":60}}}
```
