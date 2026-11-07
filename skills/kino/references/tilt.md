# 3D tilt

A product screen on a plane seen in perspective (the launch-film look). Any drawn layer
takes `rotateX` and `rotateY` (-89 to 89 degrees) and `perspective` (the eye's distance in px,
100 to 100000, default 1600; smaller is stronger). Best on a group holding the UI.

- It follows CSS `perspective(p) rotateX(rx) rotateY(ry)` around the layer's middle: positive
  rotateX tips the top away, negative rotateY brings the right side closer. The layer's own
  rotation, scale and skew happen on the plane first.
- Preset `tilt` animates all three. Without values it tips a flat layer to rotateX 30,
  rotateY -20 (or lays a tilted one flat) over 1.2 s. With `from`/`to` and a long `duration`
  it is a slow camera drift and push.
- It stays vector-sharp at any size (a grid of triangles, each within 0.3 px of the true
  perspective). Lottie export refuses a tilted layer: use video, GIF or PNG.
- Full rules: `library {topic:"rules", name:"tilt"}`.

## ui-plane: the whole look in one move

`move {name:"ui-plane", layer, at, dur?, angle?, void?, flat?}` lays real UI (a screenshot, a
recording or a `split_image` group) on a tilted plane in a dark void: the plane leans back
(`angle:"linear"` 32 degrees, bigger than the frame; `"soft"` 18; `"flat"` none), its far edges fall off into the void, a vignette closes the frame and the camera
drifts 2% a second. `void` is a dark #hex (default #060708, never pure black). `flat` (scene
seconds) swings the plane flat to 90% of the frame in 0.45 s, blurred while fast, then a slow
push (a hero moment). Start it when the shot starts; reduced motion cuts flat at `flat`
instead of swinging. The plane is never drawn past 1.3x its file's pixels, pushed in or flat; a
group is held to its most magnified piece, so a flat plane can land under 90% (the receipt says
its scale and why).

- `frame {layer, rect, at}` works on the tilted plane: the region as seen in perspective fills
  the frame, and the plane's falloff joins the camera group. A framing still in place at `flat`
  returns home over the swing (`ui-plane.camera-home`), so the plane still lands at its size.
- On a `roll` item, roll first: the void and vignette hide and show with the plane's layer.
- `carry` onto a piece of the plane's group is refused while the group is scaled; give the
  group with the `toRect` the refusal names.
- Depth of field: a `focus-band` effect on the plane's layer keeps one row sharp and tilts with the
  plane; move its centerY to rack focus (blur.md).
- The parts are `ui-plane-void`, `-falloff` and `-vignette`; a gradient that is clear in the
  middle is not a plate for check, so the plane underneath still counts as moving.

```json
{"op":"add_layer","layerType":"rectangle","name":"app","properties":{"x":360,"y":140,"width":1200,"height":800,"radius":24,"fill":"#1B1D22"}}
{"op":"move","name":"ui-plane","layer":"app","at":0,"dur":4.5,"flat":3}
{"op":"frame","layer":"app","rect":[4,52,92,26],"at":1.2}
```

```json
{"tool":"edit","ops":[{"op":"add_layer","layerType":"group","name":"screen","properties":{"x":460,"y":240,"width":1000,"height":600,"fill":"#16181f","fillEnabled":true,"radius":18,"rotateX":32,"rotateY":-22}},{"op":"add_animation","layer":"screen","preset":"tilt","start":0,"duration":4,"easing":"smooth","from":{"rotateX":40,"rotateY":-28},"to":{"rotateX":28,"rotateY":-16,"perspective":1800}}]}
{"tool":"look","mode":"frame","t":2}
```
