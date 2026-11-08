# Subject cut-out

Contents: Subject cut-out (title behind, outline, background, matte), Follow an object (track, pin), Steady shaky footage (stabilize).

Putting the subject of a video or photo (a person, an animal, an object) in a layer of its own:
titles behind the subject, outlines and glows, a new or blurred background, mattes for masks.

## Subject cut-out

- `cut_out` finds the subject of a video or image layer on this Mac (Apple Vision; nothing is
  uploaded) and adds a copy of the layer right above it, or above `above`, that shows only the
  subject. The copy keeps the layer's place, size, Play range, speed and animations, so it stays
  exactly over it, and has no sound (the layer keeps playing it). It is named `<layer>-<output>`,
  or `name`.
- `output`: `"subject"` (default: transparent around the subject), `"silhouette"` (its shape in
  `color`, default white) or `"matte"` (white on black, for `create_mask`; `invert:true` swaps
  them).
- `grow` (-100 to 100 layer pixels) makes the shape bigger, or smaller below 0; `feather`
  (0 to 200) softens its edge.
- A clip's `subject` edge is cleaned: on a shot whose camera holds still, background the matte
  kept near the edge (a motion-blurred hand over a wall) is dropped, and edge pixels take the
  subject's own color, so no halo shows over a new or darker background. A frame where Vision
  lost the subject takes the nearest good frame's shape, keyed against the empty wall.
- Keep the `"subject"` engine for a silhouette or a dark figure: `"person"` can leave the body
  half see-through (gray over a white title behind it), and the receipt's `note` says so.
- `engine:"auto"` (default) is `"subject"` (any subject, macOS 14+) or `"person"` (people only,
  macOS 13). Other systems have no engine: the edit is refused (`CUTOUT_ENGINE_UNAVAILABLE`), so
  mask with a shape there. On a Mac without the helper, `npm run desktop:cutout` builds it.
- It takes about 1.5 s per second of 1080p video, one cut-out at a time. An edit waits up to 50 s
  in all, however many cut_outs it has; a longer one answers `CUTOUT_RUNNING` with how far it got,
  changes nothing and keeps going. Send the same edit again later: the finished cut-out is kept,
  so it answers at once (`cached:true`), even while another one is being made.
- The receipt's `cutout` gives the engine, frames, seconds, `cached`, and a `note` when some
  frames had no subject. A refusal's `cutoutError` names the problem and its reason says what to
  send instead. Undo it with `history` like any edit.
- `check` sees layer boxes, not transparency, so cut-outs get `allowOverlap` (contrast then reads a
  title behind the subject against what is behind the title): use `look` to see that it still reads.
- `frame` on the layer carries its cut-outs in the camera group, with every layer stacked between
  them (a title behind the subject moves with the shot), so the subject never shows twice.

### Title behind the subject

The title goes between the clip and its cut-out:

```json
{"op":"add_layer","layerType":"video","name":"runner","properties":{"src":"/api/media/<runner>.mp4","x":0,"y":0,"width":1920,"height":1080}}
{"op":"add_layer","layerType":"text","name":"title","properties":{"text":"RUN","x":260,"y":300,"width":1400,"height":480,"fontSize":400,"fontWeight":900,"fill":"#ffffff","textAlign":"center"}}
{"op":"cut_out","layer":"runner","above":"title"}
```

### Outline or glow

A grown silhouette under the subject is an outline; a grown, feathered one is a glow:

```json
{"op":"add_layer","layerType":"video","name":"dancer","properties":{"src":"/api/media/<dancer>.mp4","x":0,"y":0,"width":1920,"height":1080}}
{"op":"cut_out","layer":"dancer","output":"silhouette","grow":30,"feather":24,"color":"#ffd166","name":"glow"}
{"op":"cut_out","layer":"dancer","output":"silhouette","grow":8,"color":"#ffffff","name":"outline","above":"glow"}
{"op":"cut_out","layer":"dancer","above":"outline"}
```

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

`track` follows one object through a video layer on this Mac (Apple Vision, no download, about
10 ms a frame). Give `at` (a second of the file) and `point` [x, y] or `box` [x, y, w, h] in % of
the source frame: `look {mode:"source", layer, t}` shows that frame with a % grid. It runs forward
and back through the part of the file the layer plays and keeps the path as a scene track. `pin`
makes any layer follow it: its center on the track's center plus `offset` (scene pixels), and
`scale:true` grows it with the object. The receipt's `track.confidence` and `note` say where
Vision was unsure (under 0.5); there the pinned layer holds its last good place and check
`track_lost` names the seconds. To see it, `look {mode:"frames"}` over the shot shows the label
moving with the object. A track made again under the same name moves its pins too; `pin {to:null}`
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
