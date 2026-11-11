# Building blocks

compose, recipes and the brand kit build most of a video; timing, cues and slots place your own
layers; variants, templates and components reuse work.

Contents: Building blocks · Timing and slots · Variants and templates · Components

## Building blocks

- `compose` builds a whole scene from beats, one recipe each, in a look and the brand kit. It
  sizes the scene, times every beat and stretches them to fill `duration`. Your own layers in
  that scene are kept. `library {topic:"blocks"}` lists the recipes (with their copy fields),
  transitions, looks and tokens; add `name` for one.
- `format {name, slots}` is a whole designer-tuned video to fill (product-launch, app-demo,
  social-promo, feature-announcement, testimonial): fixed frame, length, beats, pacing and music
  cues. Picture slots also take imported videos (a screen recording plays silent from its beat);
  `music` plays unbroken with its drop on the hero (fit_music). `library {topic:"formats",
  name}` gives its slots and an example op. It is a compose scene.
- `set_brand` once per project; compose and recipe then use its colors, fonts and logo.
- A promo or ad needs a logo beat starting by 3.8 s (logo-sting, logo-build or wordmark-type),
  a hero (device-slide with an uploaded picture, or a feature-callout: its card then fills its
  slot) and an end: cta-end, or (outside compose) the logo alone on screen, or a dip to black
  (nothing drawn over it), each marked as a rest (`update_scene {rests}`). The beats before the message (the logo beat)
  get only the time that leaves it readable by 5 s. compose refuses a plan that cannot pass, or
  beats that need more than `duration`, and says what to change.
- `compose {footage:[media ids or {media, in, out}], music?, voice?, treatment?, title?, end?,
  duration?, format?}` cuts an edit from uploaded clips instead: it picks moments by the
  transcript, faces and motion (opening on a face or the hook line), lays each shot out for the
  format (face crop, card over a blurred copy, screen over a camera shot), cuts at word edges and
  on the music's beats, and adds captions, a title, an end card and ducked music. `treatment`
  (calm, story, punchy, loud) and the deck's seed set the transitions, camera and captions; it
  ends with `check {fix:"auto"}` and the receipt's `finished`. `dry_run` gives the plan in words.
- Change one beat with `recipe` and the beat's `id` (the scene is composed again); change the
  look, duration or beats with `compose {scene, …}` (only the fields you give).
- Recipes come out clean: lines are balanced (no one-word last line; a short title fits one
  line or breaks between words), body text is at least the `type_min` floor (3% of the short side), and once a
  beat lands it drifts slowly (a 2 to 4% push and a drift, `<layer>.hold`, varied by the seed)
  until it leaves, so no hold sits still. A move started over it takes its place.

```json
{"op":"set_brand","name":"orbit","colors":{"bg":"#0f1420","surface":"#1a2233","text":"#f4f6fb","accent":"#ff7a45","accent2":"#4fd1c5"},"fonts":[{"family":"Montserrat"},{"family":"Noto Serif"}],"logos":[{"text":"Orbit"}]}
{"op":"compose","type":"promo","format":"16:9","duration":15,"look":"bold","beats":[{"recipe":"logo-sting","tagline":"Plan the week in one view"},{"recipe":"headline-reveal","text":"Your team's week, in one view","transition":"push"},{"recipe":"feature-callout","text":"Shared calendars","sub":"Everyone sees the same week"},{"recipe":"cta-end","text":"Try Orbit free","sub":"orbit.app"}]}
{"op":"recipe","name":"cta-end","id":"cta-end","text":"Start free today"}
```

Between two shots, short cut moves (0.3-0.6 s, `from`, `to`): zoom-blur, flash, light-leak,
slice, glitch, blur-dissolve, card-tilt, shape-wipe. `align:"end"` on any move ends it on `at`
(a beat cue); `"center"` centers it there.

## Timing and slots

- Timing: `at` (in recipe, and as `start` in add_animation) takes seconds,
  `"after:headline-reveal.in+0.5"`, `"with:cta-end.in+0.1"`, `"cue:<name>"` or `"auto"`
  (when the last entrance ends). `set_cue {name, at}` sets a named moment.
- Tokens: `duration` `micro` (0.15-0.3 s), `standard` (0.5-0.9), `emphasis` (0.7-1.0) or `hero`
  (1-2); `easing` `enter` and `move` (both smooth, 0.5,0,0,1), `exit` or `hero`. Recipe moves
  fade in over 0.2 s (linear) under the move; neighbors stagger 44 ms (letters 20, lines 100).
- Slots: a 6×6 grid over the safe area, columns A–F and rows 1–6 (`"B2:E5"`), or `full`,
  `center`, `top`, `bottom`, `left`, `right`, `top-left`, …. `place`, `align`, `distribute`,
  `stack` and `fit` move layers (`library {topic:"op", name:"place"}`).
- 2D camera: `frame {layer, rect:[x, y, w, h], at, cut?, to?, dur?}` reframes on a part of the
  same layer (rect in % of it): it fills the frame by default, `to:[x, y, w]` (% of the frame)
  puts its center there at that width. `cut:true` is a stepped punch-in or axial cut (exempt
  from `speed_jump`); without it, an expo-out move (0.7 s). It moves the layer's group, or a
  `<layer>-camera` group made around it (a cut at 0 opens framed). Chain calls in time order:
  2 cuts 0.6 s apart, then a move.
- A focus box over footage is one call: `recipe {name:"callout", box:[x, y, w, h], text,
  color?, corner?, at?}` makes one group (corner brackets, a plate sized to the measured label,
  role `label`), locks on, keeps the label in the safe area (below or inside the box when there
  is no room above) and keeps still on what it marks. Small UI text you make yourself takes
  role `label` (body's minimum size, never taken for the headline).
- Real UI in pieces (never redraw a UI): `split_image {layer, boxes:[{name, rect:[x, y, w, h]}]}`
  cuts a screenshot or a PNG still of a recording (rect in % of the picture) into clipping
  groups `<layer>-<name>` of its own pixels, in place; the picture is replaced, so box the
  background too. It warns above 1.3x the file's pixels. Then `move {name:"build-in", layers,
  at, empty?:0.6, stagger?:0.2, order?:"top-down", finish?:"resolve"}`: each piece blurs 6 to 0,
  fades 0.3 to 1 and rises 1% of the height, expo-out 0.4 s; `empty` holds
  the frame empty after a cut. Pieces (and their group) are placed on purpose: check
  {fix:"auto"} never moves or scales them, it lists that fix for you. `carry {to}` may land on a
  piece inside a group (its box on screen), when the group holds still and unscaled.

```json
{"op":"set_cue","name":"drop","at":"after:headline-reveal.in+0.5"}
{"op":"add_layer","layerType":"text","name":"badge","properties":{"text":"New","width":240,"height":80,"fontSize":56,"fontFamily":"Noto Serif","fill":"#f4f6fb","role":"caption"}}
{"op":"place","layers":["badge"],"slot":"top-right"}
{"op":"recipe","name":"callout","id":"keys","box":[1180,560,360,300],"text":"Keys found","color":"#ff4f9a","at":"cue:drop"}
{"op":"add_animation","layer":"badge","preset":"preset-fade","start":"cue:drop","duration":"standard","easing":"enter"}
```

## Variants and templates

- Variants: `variants {scene, vary:"layout"|"timing"|"look"|"deck"|"format", count}` adds new
  scenes beside a composed scene (deck: the project's next 3 decks); `look {mode:"variants"}` shows
  them side by side, one row each; `pick_variant {scene}` marks the one to keep. Without `seed`,
  compose and recipes use the project's seed.
- Formats: `variants {scene, vary:"format", formats:["9:16","1:1","4:5"]}` composes a beats or
  footage scene again in each format; footage crops on subjects marked on its file, your own
  layers keep their place in proportion. check {fix:"auto"} runs on each; `finished` lists what
  is left. Hand-built scenes are refused.
- Templates: `make_template {scene, intro, outro}` keeps the first and last seconds' timing
  when the scene is retimed; `use_template {template, values, duration}` makes a new scene
  from it (the receipt lists its fields); `retime {scene, duration}` changes a scene's length
  (animations, component starts and Play starts move together; `detect_beats` cues and the
  rhythm move with their sound, or the receipt's notes say to run `detect_beats` again).

```json
{"op":"variants","scene":"s1","vary":"layout","count":3}
{"op":"make_template","scene":"s1","intro":3,"outro":3}
{"op":"use_template","template":"s1","name":"Spring","values":{"cta-end":"Book a demo"},"duration":20}
```

## Components

A card used several times: build it once in its own scene, make it a component, then insert
copies that change only their text. Its scene is not part of the video.

```json
{"op":"add_scene","name":"card","width":560,"height":320}
{"op":"add_layer","scene":"card","layerType":"text","name":"card-title","properties":{"text":"Title","x":32,"y":32,"width":496,"height":60,"fontSize":44}}
{"op":"create_component","scene":"card"}
{"op":"insert_component","scene":"s1","component":"card","name":"feature-1","properties":{"x":120,"y":400,"componentOverrides":{"card-title":{"text":"Shared calendars"}}}}
```
