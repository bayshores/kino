# Blur and edges

Smears for fast moves (whip pans, zoom punches, spins), filling the frame's edges, mirrors and
kaleidoscopes, an expression per point (field), and motion blur from movement in final renders.

## Blur, edge fill and mirror

- `directional-blur {length, angle}`, `zoom-blur {amount, centerX, centerY}` and
  `spin-blur {angle, centerX, centerY}` smear a layer along a line, out from a centre or around
  it. They are value effects: `from` and `parameters` animate one, and a second one of the same
  effect without `from` carries on from the first. A blur (or glow, grade, any effect) that
  rises and falls is one pulse: `peak:0.35` (share of the window at its height) or
  `return:true`; a glow or grade without `from` starts and ends at rest. length is in the layer's own pixels; centres are fractions of its box.
- A whip: a move with `easing:"natural"` (fastest at the middle) and a directional blur along
  it that peaks there. A zoom punch: a quick scale up with a zoom blur that falls to 0.
- `edge-fill {mode: mirror|tile, extend}` repeats the picture past its edges, so a shake, spin
  or zoom-out never shows an empty edge. `mirror` and `kaleidoscope` repeat one part of the
  picture. These three cover the whole scene unless you give start and duration.
- A plain `blur` on footage or an image that fills the frame repeats its edges by itself, so a
  blur-through does not darken the frame's edges.
- Effects apply in order of start, then the order added: put `edge-fill` first, then the move,
  wiggle or blur, and a directional blur after a zoom or spin blur (6 to 12 times faster).
- They work on footage, images, text, shapes, groups and sequence parts. To blur several layers
  as one picture, group them and blur the group.
- Cost per 1920×1080 frame: about 0.2 s for a 400 px directional blur, 0.3 s for a zoom or spin
  blur, 0.8 s for one on a full-frame photo. The dashboard, `look` and every export show them.
- One-op whip: `add_animation {layer, preset:"whip-out", start:2, parameters:{direction:"down"}}`
  then `whip-in` with `direction:"up"` on the next block at 2.25. A 0.35 s slide past its own
  size that fades at the far end (exit ease-in, entrance expo-out), smeared along its path as it
  moves, so the swap hides under the blur. direction names the move into place: an exit with
  `down` leaves upward. `distance` is percent of its size (120).
- Motion blur from movement is a render setting for final renders (on by default), not an
  effect; a final draws enough samples for an even smear (render.md). The dashboard and look
  show a preview of it: each layer moving fast is smeared along its path (moves only, not scale
  or spin). check's judder counts a whip's own smear.
- `add_sequence` has `whip` and `spin` transitions built from these effects.
- Lottie: a layer with one of these effects is exported as pictures, with a warning.
- `library {topic:"rules", name:"blur"}` has every field, the order and cost rules, and recipes:
  whip-in, zoom-punch, spin-in, shake, zoom-out, kaleidoscope.
- A card that whips in from the left, then punches in at 2 s:

```json
{"op":"add_layer","layerType":"rectangle","name":"card","properties":{"x":560,"y":340,"width":800,"height":400,"fill":"#F2D21B"}}
{"op":"add_layer","layerType":"text","name":"title","properties":{"text":"WHIP","x":660,"y":460,"width":600,"height":160,"fontSize":140,"fill":"#101418","textAlign":"center"}}
{"op":"group_layers","layers":["card","title"],"name":"panel"}
{"op":"add_animation","layer":"panel","animation":{"kind":"custom","name":"Whip in","start":0,"duration":0.4,"easing":"natural","from":{"x":-1400},"to":{"x":560}}}
{"op":"add_animation","layer":"panel","effect":"directional-blur","start":0,"duration":0.2,"easing":"ease-in","from":{"length":0},"parameters":{"length":400,"angle":0}}
{"op":"add_animation","layer":"panel","effect":"directional-blur","start":0.2,"duration":0.2,"easing":"ease-out","parameters":{"length":0,"angle":0}}
{"op":"add_animation","layer":"panel","animation":{"kind":"custom","name":"Punch in","start":2,"duration":0.3,"easing":"ease-out","from":{"scaleX":1,"scaleY":1},"to":{"scaleX":1.15,"scaleY":1.15}}}
{"op":"add_animation","layer":"panel","effect":"zoom-blur","start":2,"duration":0.3,"easing":"ease-out","from":{"amount":0.25},"parameters":{"amount":0}}
```

- A blur under 0.3 s that sets its strength returns to 0 at its end; hold:true keeps it: {op:"add_animation",layer:"shot",effect:"directional-blur",start:1.12,duration:0.08,parameters:{length:220}}
- twirl (timed) turns the middle by angle 180 to 0 at radius 0.5, outside stays: {op:"add_animation",layer:"clip",effect:"twirl",start:1,duration:0.3,return:true}
- Color fringe on lines only: rgb-shift {where:"edges", colors:"green-magenta"} (red-blue, red-cyan, blue-yellow); on thin type try amount 0.08.

## Depth of field: focus-band

`focus-band {shape:"line"|"rect", centerX, centerY, angle, width:0.12, height, maxBlur:12, falloff:0.25}`
keeps a band of a flat layer sharp and blurs the rest more and more with distance, smoothly, as a
lens does (a tilted UI, a scrolling transcript). Positions and sizes are fractions of the layer's
box; maxBlur is px like the layer's `blur`; angle turns a line only (a rect stays square to the layer). The band is in the layer's own coordinates, so on a
tilted plane (`ui-plane`, rotateX) it tilts with it, and on a `split_image` group it crosses every
piece. Rack focus or follow a typing line: a second focus-band without `from` moves the band from
where the first one is (repeat any setting changed from its default). Cost: about 0.3 to 0.4 s more per 1080p frame.

```json
{"op":"add_layer","layerType":"rectangle","name":"app","properties":{"x":360,"y":140,"width":1200,"height":800,"radius":24,"fill":"#1B1D22"}}
{"op":"move","name":"ui-plane","layer":"app","at":0,"dur":4}
{"op":"add_animation","layer":"app","effect":"focus-band","start":0,"duration":0.1,"from":{"centerY":0.3},"parameters":{"centerY":0.3}}
{"op":"add_animation","layer":"app","effect":"focus-band","start":1.5,"duration":0.8,"easing":"smooth","parameters":{"centerY":0.6}}
```

## Field: an expression per point

`field {use, expression, expressionY, amount, threshold, softness, color, a, b, c, seed, grid}`
works out `expression` (math: `+ - * / ^ %`, `sin`, `noise(x,y[,z])`, `hash`, `smoothstep`, `mix`,
`length`...) of `u`, `v` (0..1 across the layer), `t` (seconds), `seed`, `a`, `b`, `c` on a grid.
`use:"alpha"` cuts where it is below `threshold` (animate 0 to 1 to dissolve or wipe in that
pattern); `"color"` mixes toward `color` by it; `"displace"` moves points `amount` px by
`(expression, expressionY)` or, with no expressionY, toward the angle `expression`. Animate a, b, c.

```json
{"op":"add_animation","layer":"app","effect":"field","start":1,"duration":1,"from":{"threshold":0},"parameters":{"use":"alpha","expression":"noise(u*10, v*10)","threshold":1}}
```
