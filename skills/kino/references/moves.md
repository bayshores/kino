# Moves

A move is a designed set piece built in one op from your layers, pictures, brand.
Most shots need none (a plain cut). Pick one or two as the signature, repeat them at alike
moments, and spend them on the hook, reveal and payoff.

Contents: The move op · The moves · Moves example · Trim paths and dashes

## The move op

- `move {name, at, dur?, id?, seed?, reduced?, look?, brand?, …its fields}`. `at` takes every
  time form (`1.2`, `"cue:drop"`, `"after:title.in"`). Layer fields take top-level layers or groups (a
  layer alone in a group, as frame makes, means the group).
- `library {topic:"moves", name?}` lists the moves, or one's fields, defaults and example.
- The receipt says when it plays, the layers it made (`<id>-<part>`) and which of yours it
  animates (`<id>.<role>-<name>`). Its id is the move's name (`-2` for a second).
- The same id again remakes it with your changes;
  `{name, id, remove:true}` takes it away. Parts are rebuilt, so do not edit them by hand;
  later ops of the same edit can name them by ID (`type-on-caret`).
- `seed` picks other choices. `reduced:true`: calm fades and small moves.
- No move runs past the scene's end: `retime` the scene or start earlier.

## The moves

- **caption-words**: captions low in the frame as written, a phrase at a time (never across a
  sentence's end), each cutting on as said, one line or two balanced. `keepCase:false`
  lowercases; `entrance:"rise"` or `"pop"`; `highlight:"active"` is karaoke. Give `words`
  [{text, at}] (forced-aligned) or `text`. Words a caption: `energy` (high 2-3, talk 3-5, calm
  4-6) or `group:1` (one word at a time); short words hold 0.3 s or pair up. `size:"small"`
  for a quiet line; `scrim:false`. Keeps clear of a status line and partial covers (`avoid`).
- **zoom-through**: pushes into a point of one shot and comes out in the next.
  `target:{layer, rect?}`: until a layer in `from` or its `rect` [x, y, w, h] % fills the
  frame; no `to`: it stays. `reverse:true` pulls back from it (or an earlier push) to the whole
  shot, 0.4 s expo-out, `title` landing. `blur:false`; `flash:"white"`. A clip `to` starts when shown.
- **whip-pan**: both shots slide a frame width, smeared.
- **push-through-type**: a big glossy word sharpens in; the camera speeds into one letter and
  the next shot shows inside it until it fills the frame.
- **logo-match-move**: the logo arrives big, then flies into its place on a page, screen or
  sign (`spot`, in % of that layer), which sharpens.
- **speed-lines-phone**: light streaks rush past a phone pushing in.
- **status-line**: an app icon with a changing status line ("is
  listening…"): big left of center, or `place:"bottom-left"` a small corner badge whose words
  cut; `size`, `swap`. Moves off text (or refuses); later footage
  goes under it; leaves before a dip to black or lone logo already there (else `dur`).
- **swipe-cards**: the top card of a stack drags aside, tilts, fills with the brand color,
  says YES or NO, flies off. `ramp:"expo"` shrinks gaps from `every` to `last` (1 s); answers hold 0.75 s.
- **roll**: `items` (words, or uploaded pictures by name) or your `layers` cut one to the next in
  place, each shorter (`first` 1.4 s to `last` 0.1 s along `ramp` expo, linear or none), then
  `land` holds `hold` 2 s (with `dur`, it lands at dur minus hold); each clip plays from its show
  time. `lead:"NEW"` stays left and slides together with the land;
  `layout:"wheel"` turns a list. Cues `<id>.1`… `<id>.land` for sound.
- **rgb-split-hit**: on each beat colors split and snap back, kicking larger (`kick:0`: no).
- **parallax-stack**: 2-4 layers (far to near) drift at different rates.
- **mask-through-shape**: the next shot opens from a circle, box or diamond at a point, ringed.
- **accent-hit**, **light-sweep**: one word or shape lit in one color (light.md).
- **tile-ring**: a shot breaks into a turning ring of tiles (it and your `pictures`).
- **build-in**: split_image pieces resolve in turn (building-blocks.md).
- **ui-plane**: UI tilted in a dark void; `flat` lays it flat (tilt.md).
- **window-punch-in**: a product window grows from 60% to 92% of frame width (by 0.8 s),
  then pushes in 2% a second (`beats:[…]`: 1.5x steps);
  `glow` 0 to 1 adds an accent glow. Start it as the window shows.
- **lift-focus**: `detail:{layer, rect?}` (a layer, or part of a picture in %) lifts to a third
  of the frame's width in the middle while the rest dims and blurs; it goes back at the end.
- **card-into-device**: a big leaning card (`picture` or `card`) turns flat, then shrinks into
  `into:{layer, rect?}` (a phone's screen, in %) as the phone fades in (`device:"there"`: on
  already). `streaks` 0 to 1.
- **carry**: one thing becomes the next shot, no cut: `{from, to, at}` (dur 0.5, expo-out).
  Box, radius, fill and turn travel into `to`'s; contents crossfade in the middle third.
  `toRect`/`fromRect` [x, y, w, h] % carry into or out of a part (a phone's screen). `to` can be
  a split_image piece.
- **cursor**: clicks or drags a split_image piece (screens).
- **freeze-shutter**: footage stops on the beat with a one-frame `shutter` (white, black or
  `kick`), holds `hold` 0.6 to 1.5 s leaning in with an optional `label`, then `release` (ramp
  or cut).
- **masked-type**: one big word made of the footage as the shot falls away around it; `subject`
  (a cut_out layer) stands it behind the person.
- **perceive-insert**: `layer` (a clip), `at`, `region` [x,y,w,h] % (default: marked subject)
  fills the frame 1s (`dur` 0.6-1.4), hard cuts, muted; `entry:"push"`, `of`, `label`.
- **voice-type**: a spoken line set big word by word; `speech`+`line` or `words`.
- **type-on**: your text `layer` (left-aligned, `role:"ui"`) types at `cps` 12, `wordPause` 0.08;
  a caret trails the last letter; `field` (the box under it) grows. Cues `<id>.1` per word,
  `<id>.typed`. All go after `hold`, as a caption comes on, or at `until`.
- **stream** (any text `layer`): words arrive `rate` 4/s (`unit:"letters"` 30), the newest two
  in `from` (accent, accent2, dim, #hex), then settle. A `dur` past 12 words/s (80 letters) is refused.
  **rewrite**: the layer, once read, blurs out; `new` streams in its place (`old` first). Hidden
  at `at` (type-on's hold over): `new` streams at once.
  **decode**: random same-case letters settle in left to right. **assemble**: letters fly
  together from a seeded `spread` {x, y, angle, scale}. `mode:"out"` reverses either.
- **draw-on**: a line, outline or route (`layer`: a stroked rectangle, ellipse, star or path)
  draws on, 0.4-1.2 s by length; a fill fades in last.

Launch-video type (words arrive faint and darken on any background):

- **headline-write**: the `headline` writes on 4 words a second, centered, with no label
  above it. `exit:"dim"` fades it to 20%.
- **logo-settle**: the logo mark (`picture` or `logo`) lands from 2.6x, the `wordmark` types on
  beside it; `header:true` shrinks the lockup into a header.
- **count-up**: an accent number counts to `value` ("98%", "$1.2M") in steady-width digits,
  most of it early; a `label` writes on under it.

Captions and status lines add a
dark box only when shadowed words could fail contrast (`scrim`). Moves
write in the brand's fonts, else the project's text font, and leave no blur or split on.

## Moves example

Zoom shot-a into shot-b at 1 s, then karaoke captions.

```json
{"op":"add_layer","layerType":"rectangle","name":"shot-b","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#1D3557"}}
{"op":"add_layer","layerType":"rectangle","name":"shot-a","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#E76F51"}}
{"op":"move","name":"zoom-through","from":"shot-a","to":"shot-b","at":1,"point":[62,40]}
{"op":"move","name":"caption-words","highlight":"active","entrance":"pop","words":[{"text":"so","at":2.2},{"text":"we gave","at":2.8},{"text":"it eyes.","at":3.5,"end":4.6}]}
```

## Trim paths and dashes

Rectangles, ellipses, stars and paths take `strokeStart`, `strokeEnd` (0 to 1 of each contour),
`strokeOffset` (turns; wraps), `dash` ([on, off, …] px) and `dashOffset` (px), all animatable.
Lottie exports them.
The `trim` preset (also `trim-paths`, `draw-on`) draws `strokeEnd` from 0; the move times it.

```json
{"op":"add_layer","layerType":"path","name":"underline","properties":{"x":560,"y":700,"width":800,"height":40,"path":"M0 20 C260 0 540 40 800 20","fillEnabled":false,"stroke":"#FFD166","strokeWidth":10}}
{"op":"add_layer","layerType":"rectangle","name":"frame","properties":{"x":460,"y":240,"width":1000,"height":400,"radius":24,"fillEnabled":false,"stroke":"#FFFFFF","strokeWidth":4,"dash":[18,12]}}
{"op":"move","name":"draw-on","layer":"underline","at":0.5}
{"op":"add_animation","layer":"frame","preset":"trim","start":0.2,"duration":1}
{"op":"add_animation","layer":"frame","animation":{"kind":"custom","start":1.2,"duration":2,"easing":"linear","from":{"dashOffset":0},"to":{"dashOffset":60}}}
```
