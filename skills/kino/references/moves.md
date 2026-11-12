# Moves

A move is a set piece built in one op from your layers. Most shots need none. Pick one or two as the signature, spend them on the hook, reveal and payoff.

Contents: The move op · The moves · Moves example (trim paths and dashes: behaviors reference)

## The move op

- `move {name, at, dur?, id?, seed?, reduced?, look?, brand?, …its fields}`. `at` takes every time form (`1.2`, `"cue:drop"`, `"after:title.in"`). Layer fields take top-level layers or groups (a layer alone in a group means the group).
- `library {topic:"moves", name}` gives one move's fields, their defaults and an example: read it before the first use. Without `name`: the list.
- The receipt says when it plays, the layers it made, which of yours it animates. Its id is its name (`-2` at another time: the receipt has the call to move the first).
- The same id, or layers and time, replaces it; `{name, id, remove:true}` removes it. Never edit its parts.
- `seed` picks other choices. `reduced:true`: calm fades, small moves.
- No move runs past the scene's end: `retime` it or start earlier.
- A transition move (`from`, `to`) keeps a held text card until the move hides it (the show it adds is `<move>.from-hide-keep`).
- Cues `<id>.1`… mark a move's steps (roll, type-on, stream) for sound.
- A refused move's `next` is your own op with the fix filled in when the refusal says so (a `dur` under one frame becomes `frames:1`, a number out of range goes to the nearest end, an unknown field to its near miss); otherwise the failing field is `"<your field>"` for you to fill in.
- Status and the deck show `for your words: "aura" -> energy-aura`: moves your stored ask names.

## The moves

What each is for; fields from `library {topic:"moves", name}`.

- **caption-words**: captions low as written, a phrase at a time, cut on as said; short words hold 0.3 s or pair up; `highlight:"active"` is karaoke. Give forced-aligned `words` [{text, at}] or `text` (captions-beats-sequences).
- **zoom-through**: pushes into a point (or a layer's `target`) of one shot and comes out in the next; `reverse:true` pulls back to the whole shot.
- **whip-pan**: both shots slide a frame width, smeared.
- **smear** (datamosh drag), **shatter** (glass shards), **split-fields** (two color fields, rough edge).
- **push-through-type**: a big glossy word (or your logo, path or group); the camera speeds into
  a letter and the next shot shows inside it until it fills the frame.
- **logo-match-move**: the logo arrives big, then flies into its `spot` on a page, screen or sign.
- **speed-lines-phone**: light streaks rush past a phone pushing in.
- **status-line**: an app icon with a changing status line, big or a corner badge; it moves off
  text on screen (or refuses).
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
  `from` into `to` (or a part of it), contents crossfade. With `toRect` the card stays inside
  the target; its own hold still ends it, so hold the card past the carry's end.
- **cursor**: clicks or drags a split_image piece (screens).
- **freeze-shutter**: footage stops on the beat with a one-frame shutter, holds, then releases.
- **speed-ramp**, **beat-repeat**: footage time on a cue (media.md).
- **masked-type**: one big word made of the footage as the shot falls away; `subject` stands it
  behind the person.
- **perceive-insert**: a region of a clip fills the frame for about 1 s, muted.
- **voice-type**: a spoken line set big word by word.
- **split-screen** `{layers:[2-4], at}`: side, stacked or slant panes. **picture-in-picture**
  `{layer, at}`: a corner inset. Mark each clip's subject first (framing): panes and insets crop
  on it, else on a face; a crop aimed at no mark or face says so first.
- **type-on**: your text layer types with a caret; a box under it grows.
- **stream**: words of any text layer arrive and settle. **rewrite**: the layer blurs out, `new`
  streams in. **decode**: random letters settle left to right. **assemble**: letters fly together.
- **draw-on**: a line, outline or route draws on; fill fades in last.
- **punch-in**: the frame snaps closer on a point. **shake**: a shake that dies down, on a cue.
- **overexpose**: a soft wash out and back, faces kept; `into` cuts at the peak.
- **backdrop-flash**: a color field flashes behind the subject (cut out for you).
- **impact-accent** `kind:"hit"`: the recolor splits its tones near the shot's luma thirds; the
  shake starts on the cue's frame at rest; `effect_fit` reads a beat cue it names
  (`at:"cue:beat-8"`). `at` in seconds sits on the measured reason within 3 frames (a cut is the
  reason), else it is a small accent (weight 0.3) and the receipt gives the distance to the nearest
  reason, and for a footage moment no cue marks, the `set_cues` call. A hit and its sound count once in `stacked`.
- **impact-silhouette** `{layer, at}`: a made impact frame: the cut-out inked flat or two-tone on a
  `plate` for `frames` (default 2 at 30 fps), then the shot's own frame. `ink` and `plate` default
  `auto` (the shot's hue). Parts: `rays` (default 12), `ticks` (a ring round the subject's box,
  default 0), `lines` (speed lines along its measured motion, default 0). It ends inside the shot,
  never past its cut; reduced motion holds the shot's frame. The note prints the matte's cover,
  whether a head box is inside it, its straight-outline share, and `at:<t>` of the nearest figure frame; it still draws. On drawn footage `mark_subject` part `"face"` first (no mark or scanned head: shape only).
  It prints `silhouette in the ink on N of M frames at 30/25/24 fps (render frame times)`; under M of M the figure shows in its own colors on the plate. An effect keyed at a Show's time draws on that rendered frame too (frames are sampled up to 1 ms early). `remove:true` leaves the cut-out it made: `delete_layer` it before running the move again for a new matte.
- **word-panel** `{textLayer, at, shape box|sign|strip, turn, pad, color, ink, layer, subject,
  enter cut|slam}`: your word on a made panel, turned with it as one group (lettering reference).
- **energy-aura**: flame, smoke or electric aura off the subject.

Launch-video type (words arrive faint, then darken): **headline-write**, **logo-settle** (the mark
lands, the wordmark types beside it), **count-up** (a number counts to `value` with a label).

- move {name:"type-on", layer, plain:true, cps:100, at:1}: plain letters, no caret/wait/hold/cues, up to 200 a second; text stays to scene end unless until. decode from:"dots" grows dots into letters.
- mosaic-reveal: a picture or clip builds out of flat-colored cells that merge and resolve to it: {"op":"move","name":"mosaic-reveal","layer":"photo","at":1} (mode "out" exits)
- An edge that sweeps across one shot: {op:"move", name:"split-fields", layer:"shot-a", at:1, travel:-1, dur:0.2}; shape-wipe grows a shape from one point instead.
- Fast whip: {op:"move",name:"whip-pan",from:"S1",to:"S2",at:0.6,frames:2} smears 2 frames from at; a clip ending mid-whip holds its edge frame (holdEnds:false shows the gap).
- Flash frame: {op:"move",name:"flash",from:"S1",to:"S2",at:"cue:<name>",frames:1}. A flat frame on a cut counts as the cut; the receipt counts flash frames within 1 s (check allows 3).
- overexpose takes saturation (default 1.4 at the peak, 1 the old wash).

## Moves example

Zoom shot-a into shot-b at 1 s, then karaoke captions.

```json
{"op":"add_layer","layerType":"rectangle","name":"shot-b","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#1D3557"}}
{"op":"add_layer","layerType":"rectangle","name":"shot-a","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#E76F51"}}
{"op":"move","name":"zoom-through","from":"shot-a","to":"shot-b","at":1,"point":[62,40]}
{"op":"move","name":"caption-words","highlight":"active","entrance":"pop","words":[{"text":"so","at":2.2},{"text":"we gave","at":2.8},{"text":"it eyes.","at":3.5,"end":4.6}]}
```
