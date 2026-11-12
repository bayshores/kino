# Edits

How to write `edit` ops. `library {topic:"op", name:"add_layer"}` gives one op's full rules and
an example that works (several at once: `name:["add_layer","add_animation"]`).

Contents: Ops and names · Refusals and fixes · Examples · Animations · Fonts · Rebuilding

## Ops and names

- `ops` is a list of `{op, …}`. `name` on `add_layer`, `group_layers` or `insert_component`
  becomes its ID; codes (`L3`, `A2`, `s1`) work too. `headline.in` is the `in` animation of
  `headline` once an earlier edit saved it (in the same edit, name the layer). A name not
  found is refused with `didYouMean`. A scene or layer added earlier in the same edit can be
  used by its name or its coming code.
- `add_layer` takes animations inline: `animations:[{preset, start, duration, …}]` (the
  `add_animation` fields without `layer`) or `[{kind:"custom", …}]`. A layer property sent next
  to `properties` (`text`, `x`, …) is moved into them (in `fixed`); any other unknown field is
  refused, never dropped.
- Text boxes do not grow by themselves: a `width` and `height` that fit, or
  `textResize:"width-height"`.
- Colors are hex (`#00000000` transparent); color words, `rgba()`, `hsl()` and CSS gradients
  convert. Corners: `radius` or `cornerRadii` (four). A property no layer has is refused with
  the closest names; a field an op does not have is ignored, and the receipt's notes give the
  closest field and the op's field line (`duplicate_layers` `times:[4,8]`: Did you mean `at`?).
- `rev` (optional): the revision you read; a changed project takes the edit when it still fits
  (`rebased:true`), else refuses it.
- `set_font` over shapes sets only the text layers. Leave out fields at their defaults (text:
  weight 400, line height 1.2, left aligned); set the font.
- style_text_range {layer, text:"P", style:{scaleX:-1}} mirrors one letter in place (scaleX/scaleY -10..10, not 0). A scale or turn's receipt names its pivot: anchor is [x%, y%] of the box.
- import_svg {name:"logo", svg} names its top-level layers "logo", "logo 2"; a receipt note lists them. One duplicate_layers copy is "<name> copy" (id "<name>-copy").
- set_font on a face missing a glyph sets it, the glyph in a fallback.
- Drawn prop, logo or brush word in footage? Trace it into vector shapes: {op:"trace_image", layer:"<clip layer>", time:2.6, region:[x,y,w,h], name:"logo"}

## Refusals and fixes

- A refused edit saves nothing. It lists the failing ops with the reason (the first with its
  `rules` and an `example` op that works, then up to 4 more in `alsoRefused`); `missing` lists
  every name not found. Its code is such as `E2`. Send only the fixes:
  `edit {retry:"E2", fix:{"3":{"easing":"smooth", "pacing":null}, "7":null}}` changes op 3,
  removes its pacing and drops op 7; a fix with `op` replaces the op. Op numbers and fix keys
  count from 0; a key from the op count up adds an op, or a list of ops, after the refused ones.
- A shape with one meaning is fixed and listed in `fixed` (`add_text`, `"48px"`, `"500ms"`,
  `fontWeight:"bold"`, `ease`, a preset sent with values, timed `keyframes`).
- Refused: a percent `x` or `y` (`place` centers), a field the animation lacks (`repeat`: a
  `behavior` loop), `from`/`to` with a preset change, a field given two values (`size`,
  `width`), a `src` file path (import first).
- notMade names layers a refused edit did not make. Its `next:` is `edit {retry:"E1", fix:{...}}` with known fixes filled in; send it as given.

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
  `preset-whip`, `preset-mask`, `preset-wipe`, `preset-appear`, `preset-custom-text`. `"mode":"out"`
  reverses one into an exit. Property animations (`move`, `scale`, `opacity`, `blur`, …):
  `library {topic:"presets"}`; `library {topic:"op", name:"add_animation"}` gives each one's `to`.
- Easing (`library {topic:"easings"}`): `smooth` (long settle), `expo-out` or `snap` (fast in),
  `overshoot`, `steps-4` (4 held poses), `linear`, `[x1,y1,x2,y2]`, …. Presets: smooth, fades linear.
- 3+ steps: `keys:[{t, value, ease?}]` for from/to (behaviors.md).
- An effect's settings are in `to` (and `from`): color reference, "Changing an effect".
- slide, grow, rotate, blur, blur-slide never fade; check's auto fix adds a fade, and makes a
  blur entrance a plain fade (blur+fade in is the AI tell). An entrance holds its first frame
  until it starts.
- An animation's value is drawn over the layer's: to hide a layer, `update_layer`
  `properties:{visible:false}`, not `opacity:0`.
- Moving a layer moves its presets too; for custom x and y, starts away from where a layer is
  drawn, or ends using an old value, the receipt gives the `update_animation` ops that fix them.
- `preset` also takes `{id, mode, parameters}`, the shape a layer's animation keeps. Animation
  codes (A12) stay the same between reads: deleting one and then `match_references` in the same
  edit no longer renumbers the deleted ones.

## Fonts

- `library {topic:"fonts", search:"Roboto"}` finds a font (`"∞"`: by character; `"brush"`, `"slab"`,
  `"japanese"`, `"bold sans"`: by look); `set_font` downloads it. A family you name comes
  first (`search:"Anton condensed bold"` lists Anton first); a lone word like "big" is a look.
- `set_font` refuses a font lacking a character; its `instead` (`edit {retry, fix:{"<n>":
  <instead>}}`) draws just those in another font.
- Variable fonts: text `axes:{wght, wdth, slnt, opsz}` (merged per axis, `{wdth:null}` drops
  one), animated by `animation:{kind:"custom", from:{axes:{wght:100}}, to:{axes:{wght:900}}}`.
- `outline_text {layer}`: letters become path layers in a group; the text is hidden.
- `library {topic:"fonts"}` lists faces measured from your saved type labels first (whole frame, any second). To measure just the letters: `like:"yt:X"` or `like:"/abs/frame.png"`, `t`, `region:[x,y,w,h]`, `text:"THE WORDS"`; each face comes with a set_font call, and `text` makes width reliable. Without `region`, `like` finds the lettering box.

## Rebuilding

For a long edit, keep the ops in files, a script that sends them in order and stops at the
first refused edit (`kino edit` exits 1; `set -e`), and a `PROGRESS.md` of names, decisions and
what is left, so a restart costs little.

- From nothing: a new project id, then the script. Imported `src` addresses work in every
  project; a taken project id is refused.
- In place: build each pass inside one group (`group_layers`); deleting the group deletes its
  layers. Without groups, list every name first: for each scene, `status {scene, full:true}`
  and on while it offers `status {full:true, page:N}` (`inspect` shows at most 10). Delete only those;
  layers indented under a group go with it; one name not found refuses the whole edit.
- A name that is taken gets an ID ending in `-2` (receipt `renamed`).
- Do not delete and add scenes to rebuild: deleting a scene waits for the person's approval.
