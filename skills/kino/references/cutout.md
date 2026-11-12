# Subject cut-out

Contents: Subject cut-out (title behind, outline, background, matte), Follow an object (track, pin), Steady shaky footage (stabilize). Split-screen and picture-in-picture: moves.

Putting the subject of a video or photo (a person, an animal, an object) in a layer of its own:
titles behind the subject, outlines and glows, a new or blurred background, mattes for masks.

## Subject cut-out

- `cut_out` finds the subject of a video or image layer on this Mac (Apple Vision; nothing is
  uploaded) and adds a soundless copy right above it (or above `above`) that stays exactly over
  it, named `<layer>-<output>` or `name`. Every field, default and receipt field:
  `library {topic:"rules", name:"cutout"}`.
- `output`: `"subject"` (default), `"silhouette"` (its shape in `color`), `"outline"` (a path on
  its edge) or `"matte"` (for `create_mask`). `grow` and `feather` widen and soften the shape.
  `points:[[x,y]]` (% of the clip's own picture, look `mode:"source"`) keeps only the objects
  under them, `exclude` drops one; the receipt's `picked` `lost`/`weak` spans say where it slipped.
- All outputs share one cleaned edge (`refine`, `fillHoles`, `openEdges` fades it where the
  frame cuts the subject; a clip's edge drops still background near it, no halo); a frame where
  Vision lost the subject takes the nearest good shape.
- Keep the `"subject"` engine for a silhouette or a dark figure: `"person"` can leave the body
  half see-through (gray over a white title behind it), and the receipt's `note` says so.
- macOS 14+ (`"person"`, people only, on 13); elsewhere refused (`CUTOUT_ENGINE_UNAVAILABLE`):
  mask with a shape. A missing or old helper: `npm run desktop:cutout` builds it.
- About 1.5 s per second of 1080p. Over 50 s it answers `CUTOUT_RUNNING`, changes nothing and
  keeps going: send the same edit later (`cached:true`). The receipt's `subject` gives its box
  and the `room` beside it (scene px) to place type without a look.
- Cut-outs get `allowOverlap`; `type_covered` warns when the subject's box hides most of a title
  behind it. `covered_layer` and `held_static` skip the source clip.
- `frame` on the layer carries its cut-outs in the camera group, with every layer stacked between
  them (a title behind the subject moves with the shot), so the subject never shows twice.
- A subject cut off by the frame reaches the border (openEdges "extend", default). edge "auto" is crisp on video drawn on 2s/3s, else soft: cut_out {layer:"clip", edge:"crisp"}

### Title behind the subject

The title goes between the clip and its cut-out (`type-behind`: keep it for 1 to 3 key beats;
`technique_repeat` warns from the 4th):

```json
{"op":"add_layer","layerType":"video","name":"runner","properties":{"src":"/api/media/<runner>.mp4","x":0,"y":0,"width":1920,"height":1080}}
{"op":"add_layer","layerType":"text","name":"title","properties":{"text":"RUN","x":260,"y":300,"width":1400,"height":480,"fontSize":400,"fontWeight":900,"fill":"#ffffff","textAlign":"center"}}
{"op":"cut_out","layer":"runner","above":"title"}
```

`behind:"title"` does this in one call (the text moves right above the clip). The clip's people
scan picks the engine: few people, subject; else person, then subject; `engine` overrides it.

Type that must read whole goes beside the subject: `place {layers:["word"], around:"<cut-out>"}`
(or a shot, or `"subject"`: the marked subject of the shot under the text) sets it in the free
room, shrunk to fit, clear of the subject for the whole time the text shows (up to 24 sampled
seconds). `around` is required: without it the refusal names it. `side` is left,
right, above, below or split. With no `side` it keeps the type largest, then moves it least: text
already clear stays put. `split` sets one line in two parts at a word gap, the second a new layer
`<name> 2`. `follow:true` instead moves it with the subject on a pin path (track "around"), the
shortest move clear of it at every moment, same size. A face mark, or a face kino found, counts as
a person down to the picture's bottom, so no text goes below it. The receipt prints the letter
share inside the subject box at the worst moment before and after, the room on each side, the
hold and how far a moving subject moves, and says when no spot is clear for the whole hold;
`type_covered` lists that room and the call to send. A cut-out copy keeps `subjectPath` (the
subject box over time), which `around` reads. A title set between a clip and its cut-out is never
covered by a later clip: kino leaves it where it is.

### Outline or glow

A grown silhouette under the subject is an outline; a grown, feathered one is a glow:

```json
{"op":"add_layer","layerType":"video","name":"dancer","properties":{"src":"/api/media/<dancer>.mp4","x":0,"y":0,"width":1920,"height":1080}}
{"op":"cut_out","layer":"dancer","output":"silhouette","grow":30,"feather":24,"color":"#ffd166","name":"glow"}
{"op":"cut_out","layer":"dancer","output":"silhouette","grow":8,"color":"#ffffff","name":"outline","above":"glow"}
{"op":"cut_out","layer":"dancer","above":"outline"}
```

A subject cut_out leaves the clip's glow on the clip, so it shines behind the subject. To bloom the subject too, add a glow to the cut-out layer.

### New or blurred background

Blur the clip under its subject, or put a backdrop between them (the clip stays below it and
keeps its sound):

```json
{"op":"add_layer","layerType":"video","name":"talk","properties":{"src":"/api/media/<talk>.mp4","x":0,"y":0,"width":1920,"height":1080}}
{"op":"cut_out","layer":"talk"}
{"op":"update_layer","layer":"talk","properties":{"blur":30}}
```

```json
{"op":"add_layer","layerType":"video","name":"guest","properties":{"src":"/api/media/<guest>.mp4","x":0,"y":0,"width":1920,"height":1080}}
{"op":"add_layer","layerType":"rectangle","name":"backdrop","properties":{"x":0,"y":0,"width":1920,"height":1080,"fill":"#14213d"}}
{"op":"cut_out","layer":"guest","above":"backdrop"}
```

### A matte for masks

A layer masked by the matte shows only inside the subject (a double exposure):

```json
{"op":"add_layer","layerType":"image","name":"portrait","properties":{"src":"/api/media/<portrait>.png","x":0,"y":0,"width":1920,"height":1080}}
{"op":"cut_out","layer":"portrait","output":"matte"}
{"op":"add_layer","layerType":"video","name":"city","properties":{"src":"/api/media/<city>.mp4","x":0,"y":0,"width":1920,"height":1080,"opacity":0.8}}
{"op":"create_mask","layers":["portrait-matte","city"],"maskLayerId":"portrait-matte","name":"double exposure"}
```

Any mask takes `maskInvert:true` (show only outside it) and `maskMode:"alpha"` (cut by a
picture's transparency, so a `"subject"` cut-out or a logo PNG works as the mask); feather is
the mask's `blur`, strength its `opacity`. `library {topic:"masks"}`.

## Follow an object

`track` follows one object through a video layer on this Mac (Apple Vision, no download). Give `at` (a second of the file) and `point` [x, y] or `box` [x, y, w, h] in % of
the source frame: `look {mode:"source", layer, t}` shows that frame with a % grid. It runs forward
and back through the part of the file the layer plays and keeps the path as a scene track. `pin`
makes any layer follow it: its center on the track's center plus `offset` (scene pixels), and
`scale:true` grows it with the object. The receipt's `track.confidence` and `note` say where
Vision was unsure (under 0.5); there the pinned layer holds its last good place and check
`track_lost` names the seconds. Check it with `look {mode:"frames"}`. A track made again under the same name moves its pins too; `pin {to:null}`
lets go.

```json
{"op":"add_layer","layerType":"video","name":"walk","properties":{"src":"/api/media/<walk>.mp4","x":0,"y":0,"width":1920,"height":1080}}
{"op":"track","layer":"walk","at":1,"point":[50,40],"name":"phone"}
{"op":"add_layer","layerType":"text","name":"label","properties":{"text":"Acme","fontSize":48,"fill":"#ffffff"}}
{"op":"pin","layer":"label","to":"phone","offset":[0,-120]}
```

## Steady shaky footage

`stabilize` steadies a handheld or walking clip on this Mac (Apple Vision measures the camera
motion on the background, with people left out; Core Image moves each frame; files up to 1080p;
a few seconds per second of 1080p). The camera path is smoothed over `smooth` seconds (default 1;
more is steadier, less keeps quick moves) and one fixed `zoom` crops the whole clip so no edge
shows: the least that works, at most 1.15, unless you give it. The layer then plays the steadied
copy, sound unchanged. The receipt gives `src`, `zoom` and `jerk` {before, after} {mean, worst}
(background frame-to-frame jerk, px at 1080p). If the copy's worst jerk is higher than the
file's, the layer keeps its file and the receipt says `kept:"original"`. Stabilize before `track`,
so the track follows the steady picture.

```json
{"op":"add_layer","layerType":"video","name":"walk","properties":{"src":"/api/media/<walk>.mp4"}}
{"op":"stabilize","layer":"walk","smooth":1}
```
