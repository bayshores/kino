# Moves

A move is a set piece built in one op from your layers.
Most shots need none. Pick one or two as the signature, spend them
on the hook, reveal and payoff.

Contents: The move op · The moves · Moves example · Trim paths and dashes

## The move op

- `move {name, at, dur?, id?, seed?, reduced?, look?, brand?, …its fields}`. `at` takes every
  time form (`1.2`, `"cue:drop"`, `"after:title.in"`). Layer fields take top-level layers or
  groups (a layer alone in a group means the group).
- `library {topic:"moves", name}` gives one move's fields, their defaults and an example:
  read it before the first use. Without `name`: the list.
- The receipt says when it plays, the layers it made, which of yours it animates. Its id is its
  name (`-2` at another time: the receipt has the call to move the first).
- The same id, or layers and time, replaces it; `{name, id, remove:true}` removes it. Never
  edit its parts.
- `seed` picks other choices. `reduced:true`: calm fades, small moves.
- No move runs past the scene's end: `retime` it or start earlier.
- Cues `<id>.1`… mark a move's steps (roll, type-on, stream) for sound.

## The moves

What each is for; fields from `library {topic:"moves", name}`.

- **caption-words**: captions low as written, a phrase at a time, cut on as said, one or two
  lines; short words hold 0.3 s or pair up; `highlight:"active"` is karaoke. Give forced-aligned
  `words` [{text, at}] or `text`.
  Font, colors, word box: captions-beats-sequences.md.
- **zoom-through**: pushes into a point (or a layer's `target`) of one shot and comes out in the
  next; `reverse:true` pulls back to the whole shot.
- **whip-pan**: both shots slide a frame width, smeared.
- **smear** (datamosh drag), **shatter** (glass shards), **split-fields** (two color fields, rough edge).
- **push-through-type**: a big glossy word (or your logo, path or group); the camera speeds into
  a letter and the next shot shows inside it until it fills the frame.
- **logo-match-move**: the logo arrives big, then flies into its `spot` on a page, screen or sign.
- **speed-lines-phone**: light streaks rush past a phone pushing in.
- **status-line**: an app icon with a changing status line, big or a corner badge; it moves off
  text on screen (or refuses); footage goes under it.
- **swipe-cards**: a card stack swiped YES or NO in the brand color, faster and faster.
- **roll**: words, pictures or your `layers` cut one to the next in place, each shorter, then
  land and hold; `layout:"wheel"` turns a list.
- **rgb-split-hit**: on each beat colors split and snap back.
- **parallax-stack**: 2-4 layers (far to near) drift at different rates.
- **mask-through-shape**: the next shot opens from a circle, box or diamond.
- **accent-hit**, **light-sweep**: one word or shape lit in one color (light.md).
- **tile-ring**: a shot breaks into a turning ring of tiles.
- **build-in**: split_image pieces resolve in turn (building-blocks.md).
- **ui-plane**: UI tilted in a dark void (tilt.md).
- **window-punch-in**: a product window grows to fill the frame, then pushes in slowly.
- **lift-focus**: a detail lifts to the middle while the rest dims and blurs, then goes back.
- **card-into-device**: a big leaning card turns flat and shrinks into a phone's screen.
- **carry**: one thing becomes the next shot, no cut: box, radius, fill and turn travel from
  `from` into `to` (or a part of it), contents crossfade.
- **cursor**: clicks or drags a split_image piece (screens).
- **freeze-shutter**: footage stops on the beat with a one-frame shutter, holds, then releases.
- **speed-ramp**, **beat-repeat**: footage time on a cue (media.md).
- **masked-type**: one big word made of the footage as the shot falls away; `subject` stands it
  behind the person.
- **perceive-insert**: a region of a clip fills the frame for about 1 s, muted.
- **voice-type**: a spoken line set big word by word.
- **split-screen**, **picture-in-picture**: panes, a corner inset (cutout.md).
- **type-on**: your text layer types with a caret; a box under it grows.
- **stream**: words of any text layer arrive and settle. **rewrite**: the layer blurs out, `new`
  streams in. **decode**: random letters settle left to right. **assemble**: letters fly together.
- **draw-on**: a line, outline or route draws on; fill fades in last.
- **punch-in**: the frame snaps closer on a point. **shake**: a shake that dies down, on a cue.
- **overexpose**: a soft wash out and back, faces kept; `into` cuts at the peak.
- **backdrop-flash**: a color field flashes behind the subject (cut out for you).
- **energy-aura**: flame, smoke or electric aura off the subject.

Launch-video type (words arrive faint, then darken): **headline-write** (writes on, centered),
**logo-settle** (the mark lands, the wordmark types beside it), **count-up** (a number counts
to `value` with a label).

Moves use the brand's fonts (else the project's); a `scrim` only where words could fail.

## Moves example

Zoom shot-a into shot-b at 1 s, then karaoke captions.

```json
{"op":"add_layer","layerType":"rectangle","name":"shot-b","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#1D3557"}}
{"op":"add_layer","layerType":"rectangle","name":"shot-a","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#E76F51"}}
{"op":"move","name":"zoom-through","from":"shot-a","to":"shot-b","at":1,"point":[62,40]}
{"op":"move","name":"caption-words","highlight":"active","entrance":"pop","words":[{"text":"so","at":2.2},{"text":"we gave","at":2.8},{"text":"it eyes.","at":3.5,"end":4.6}]}
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
