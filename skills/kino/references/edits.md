# Edits

How to write `edit` ops. `library {topic:"op", name:"add_layer"}` gives one op's full rules and
an example that works (several at once: `name:["add_layer","add_animation"]`).

Contents: Ops and names · Refusals and fixes · Examples · Animations · Fonts · Rebuilding

## Ops and names

- `ops` is a list of `{op, …}`. Name things: `name` on `add_layer`, `group_layers` or
  `insert_component` becomes its ID, so later ops can say
  `layer:"headline"`. Codes (`L3`, `A2`, `s1`) also work, and `headline.in` means the `in`
  animation of `headline` once an earlier edit has saved it (in the same edit, name the layer:
  `stagger_animations` items may be layers). A name that is not found is refused with
  `didYouMean`.
- `add_layer` takes the layer's animations inline: `animations:[{preset, start, duration, …}]`
  (the `add_animation` fields without `layer`) or `[{kind:"custom", …}]`. A layer property sent
  next to `properties` (`text`, `x`, …) is moved into them (in `fixed`); any other unknown
  field is refused, never dropped.
- One scene: no `scene` needed. Several: add `scene:"s2"` (or its name). A scene or
  layer added earlier in the same edit can be used by its name or its coming code.
- Positions are the layer's top-left corner in scene pixels. Text boxes do not grow by
  themselves: give text layers a `width` and `height` that fit, or `textResize:"width-height"`.
- Colors are hex (`#ffffff`, `#00000000` for transparent); color words, `rgba()`, `hsl()` and
  CSS gradients are converted (in `fixed`).
- Rounded corners are `radius` (one number) or `cornerRadii` (four); `cornerRadius` and
  `borderRadius` are converted. A property no layer has is refused with the closest names.
- `rev` (optional): the revision you read. If the project changed since, the edit goes onto
  the new version when it still fits (`rebased:true`), else is refused.
- A `role` one letter off is corrected (in `fixed`); `set_font` over shapes sets only the text
  layers (`notes` names the rest).
- Leave out fields at their defaults (text: weight 400, line height 1.2, left aligned); set the font.

## Refusals and fixes

- A refused edit saves nothing. It lists the failing ops with the reason (the first with its
  `rules` and an `example` op that works, then up to 4 more in `alsoRefused`); ops that use a
  refused layer are still checked. `missing` lists every name not found
  (`{layer:[…], animation:[…]}`). Its code is such as `E2`. Send only the fixes:
  `edit {retry:"E2", fix:{"3":{"easing":"smooth", "pacing":null}, "7":null}}` changes op 3,
  removes its pacing and drops op 7; a fix with `op` replaces the op.
- A shape with one meaning is fixed and listed in `fixed`, not refused: an op
  name such as `add_text` or `animate`, `"48px"`, `"50%"` opacity, `"500ms"`, `fontWeight:"bold"`,
  `font` or `color` on text, `ease` for `easing`, a property preset sent with values
  (`preset:"move", parameters:{x}`), an animation with `from`/`to` but no `kind`, timed `keyframes`.
- Refused: a percent `x` or `y` (`place` centers), a field the animation lacks
  (`durration`; `repeat`: a `behavior` loop), `from`/`to` with a preset change, a field given
  two values (`size`, `width`) and a `src` file path (import it first).

## Examples

One scene, 1920×1080:

```json
{"op":"update_scene","properties":{"duration":6,"background":"#0b1020"}}
{"op":"add_layer","layerType":"rectangle","name":"card","properties":{"x":360,"y":240,"width":1200,"height":600,"fill":"#151b33","radius":32}}
{"op":"add_layer","layerType":"text","name":"headline","properties":{"text":"Ship faster","x":360,"y":420,"width":1200,"height":160,"fontSize":120,"fontWeight":700,"fill":"#ffffff","textAlign":"center"}}
{"op":"add_animation","layer":"card","preset":"preset-grow","start":0,"duration":0.5}
{"op":"add_animation","layer":"headline","preset":"preset-slide","start":0.3,"duration":0.6,"parameters":{"direction":"up","distance":40}}
{"op":"add_animation","layer":"headline","preset":"preset-fade","mode":"out","start":5.4,"duration":0.4}
{"op":"stagger_animations","items":["card","headline"],"delay":0.12}
{"op":"set_font","layers":["headline"],"family":"Montserrat","weight":700}
```

A layer with its entrance and exit in one op:

```json
{"op":"add_layer","layerType":"text","name":"tagline","properties":{"text":"Plan the week in one view","x":460,"y":620,"width":1000,"height":80,"fontSize":48,"role":"subhead"},"animations":[{"preset":"preset-fade","start":0.6,"duration":0.5},{"preset":"preset-fade","mode":"out","start":5.4,"duration":0.4}]}
```

A custom animation (`from` left out starts where the layer is drawn then), alone or inline in
`add_layer`:

```json
{"op":"add_animation","layer":"tagline","animation":{"kind":"custom","name":"Move","start":1,"duration":1.5,"to":{"x":200}}}
{"op":"add_layer","layerType":"ellipse","name":"dot","properties":{"x":200,"y":900,"width":40,"height":40},"animations":[{"kind":"custom","name":"Glide","start":1,"duration":1.5,"to":{"x":1680}}]}
```

A second scene (from then on every op names its `scene`):

```json
{"op":"add_scene","name":"cta","width":1920,"height":1080,"duration":4,"background":"#0b1020"}
{"op":"add_layer","scene":"cta","layerType":"text","name":"cta-line","properties":{"text":"Try it free","x":460,"y":470,"width":1000,"height":140,"fontSize":96,"fontWeight":700,"fill":"#ffffff","textAlign":"center"}}
```

## Animations

- In presets: `preset-fade`, `preset-slide`, `preset-grow`, `preset-blur`, `preset-blur-slide`,
  `preset-whip`, `preset-mask`, `preset-wipe`, `preset-appear`, `preset-custom-text`. Add `"mode":"out"` for
  an exit; it reverses the entrance (`direction:"up"` leaves downward). Property animations:
  `move`, `scale`, `rotate`, `opacity`, `color`, `blur`, … (`library {topic:"presets"}`;
  `library {topic:"op", name:"add_animation"}` gives each one's `to`).
- Easing: `smooth` (long settle), `natural`, `expo-out` or `snap` (fast in),
  `quart-out`, `in-out`, `ease-in`, `ease-out`, `overshoot`, `elastic`, `bounce`, `impulse`,
  `swing`, `linear`, `steps-4` (4 held poses), `[x1,y1,x2,y2]`. Presets: smooth, fades
  linear; `easeOutBack` and `cubic-bezier()` convert.
- 3+ steps: `keys:[{t, value, ease?}]` for from/to (behaviors.md).
- An effect's settings are in `to` (and `from`): `update_animation {animation:"plate.effect",
  properties:{to:{gamma:0.6}}}` changes gamma and keeps the others.
- slide, grow, rotate, blur, blur-slide never fade; check's auto fix adds a fade, and makes a
  blur entrance a plain fade (blur+fade in is the AI tell). An entrance holds its first frame
  until it starts.
- An animation's value is drawn over the layer's: `opacity:0` on a layer whose fade-in ends at
  opacity 1 leaves it on screen; the receipt gives the `update_animation` for each end
  that used the old value. To hide a layer, `update_layer` `properties:{visible:false}`.
- Moving a layer moves its presets too (receipt `movedWithLayer`). Custom x and y stay
  behind; the receipt gives ops that move them by one amount, so a chain stays joined.
- An animation that starts away from where its layer is drawn jumps there; the receipt gives
  the `update_animation` that starts it there (an exit keeps its length and direction).

## Fonts

- `library {topic:"fonts", search:"Roboto"}` finds a font, its `fontSource` (`search:"∞"`
  by character); `set_font` downloads it if needed.
- `set_font` refuses a font that lacks a character. Its `instead` (`edit {retry, fix:{"<n>":
  <instead>}}`) draws just those in another font (check's `missing_glyphs` fix).
- Variable fonts: text `axes:{wght, wdth, slnt, opsz}` (merged per axis, `{wdth:null}` drops
  one), animated by `animation:{kind:"custom", from:{axes:{wght:100}}, to:{axes:{wght:900}}}`.
- `outline_text {layer}`: letters become path layers in a group; the text is hidden.

## Rebuilding

For a long edit, keep from the start:

- the ops in files and a script that sends them in order and stops at the first refused edit
  (`kino edit` exits 1; `set -e` in a shell script), so the video can be rebuilt
  from nothing;
- a `PROGRESS.md` with the names you chose, your decisions and what is left, so a restart
  costs little.

To rebuild:

- From nothing: create a project with a new id and run the script. Imported `src` addresses
  work in every project; a project id that is taken is refused.
- In place: build each pass inside one group (`group_layers`); deleting the group deletes its
  layers. Without groups, list every name first: for each scene, `status {scene, full:true}`
  and on while it offers `status {full:true, page:N}` (`inspect` shows at most 10). Delete
  only those; one name that is not found refuses the whole edit (`missing` names them). Names
  indented under a group go with it (a later delete of one is skipped; `notes` says so).
- A name that is taken gets an ID ending in `-2`; the receipt lists it: `renamed:{"fog":"fog-2"}`.
- Do not delete and add scenes to rebuild: deleting a scene waits for the person's approval.
