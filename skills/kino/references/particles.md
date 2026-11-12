# Particles

Overlays made inside kino: embers, sparks, snow, dust, rain, streaks, bokeh, fog and light
leaks. No stock overlay file is needed.

## Particles and overlays

- Each generator is an effect (`effect:"embers"` and so on) that draws inside its layer's box.
  Put it on a carrier: a rectangle the size of the frame with `fillEnabled:false`,
  `strokeWidth:0`, and `blendMode:"add"` for light (embers, sparks, dust, bokeh, light-leaks) or
  the normal blend for things that cover (snow, rain, fog). A new layer goes on top;
  `move_layers` with `position:"below"` puts it behind a title.
- Settings: count, size, speed, direction (0 up, 90 right, 180 down), spread, gravity, wind,
  turbulence, lifetime, color and color2, opacity, softness, glow, flicker, trail, emitter
  (area, bottom, top, left, right, point with originX/originY), prewarm, seed and loop.
  `library {topic:"rules", name:"particles"}` has every range and default and names nine
  recipes; `library {topic:"rules", name:"particle-recipes", search:"snow-loop"}` gives one as
  the ops to send (leave out search for all nine).
- `variation` 0..1 spreads each dot's depth: size, speed, trail length, brightness, glow and
  color (color far, color2 near); `haze` 0..1 adds a soft bloom under them. `effect:"streaks"` (add blend) is a falling streak field with
  depth in one layer (code rain, light streaks); put it under a cut-out subject.
- `links` N joins dots closer than N px with lines (a constellation, network): dust {count:14, links:320}.
- The picture at a time depends only on the settings, the seed and that time, so the look,
  the dashboard and every export show the same frame. `from` animates settings: count is read
  when each particle is born (lowering it lets living ones finish), speed, direction, wind and
  gravity bend paths smoothly, and colours, size and opacity change at once. lifetime, seed,
  loop, emitter and prewarm stay fixed.
- `loop` (seconds) repeats the picture exactly: use it for GIF, APNG and Lottie. Lottie keeps a
  generator as embedded frames (each distinct frame once), refuses one on the add blend, and
  refuses frames over 64 million pixels in all. A full-frame 1080p generator fits with render
  `options:{imageDPIRatio:"original"}`, 30 fps or less and a loop of 1 s or less.
- Counts are capped per look (embers 1,500, sparks 800, snow, dust and rain 2,000, bokeh 300,
  fog 64, light-leaks 16). Fewer, bigger particles cost less. The dashboard plays them at 30 fps;
  a 1080p video of fog or light-leaks takes about 0.1 s a frame (APNG about 0.5 s), a PNG sequence
  or GIF about 0.3 s.
- Embers and sparks twinkle fast; `check` reports flashing when big, bright twinkling particles
  cover much of the frame. Lower flicker, size or count to pass.
- Embers rising behind a title:

```json
{"op":"add_layer","layerType":"text","name":"title","properties":{"text":"Into the night","x":360,"y":440,"width":1200,"height":200,"fontSize":120,"fill":"#F4EFE6","textAlign":"center"}}
{"op":"add_layer","layerType":"rectangle","name":"embers","properties":{"x":0,"y":0,"width":1920,"height":1080,"fillEnabled":false,"strokeWidth":0,"blendMode":"add"},"animations":[{"effect":"embers","parameters":{"count":180}}]}
{"op":"move_layers","layers":["embers"],"position":"below","referenceId":"title"}
```

- In a later edit, change its settings by the name the receipt gave it (settings left out stay):

```json
{"op":"update_animation","layer":"embers","animation":"embers.effect","properties":{"to":{"count":240,"wind":30}}}
```

- A shower of sparks on a cue that dies out over 1.5 s (count and opacity fall to 0):

```json
{"op":"set_cues","cues":[{"name":"hit","time":2}]}
{"op":"add_layer","layerType":"rectangle","name":"sparks","properties":{"x":0,"y":0,"width":1920,"height":1080,"fillEnabled":false,"strokeWidth":0,"blendMode":"add"},"animations":[{"effect":"sparks","start":"cue:hit","duration":1.5,"from":{"count":400,"opacity":1},"parameters":{"count":0,"opacity":0,"prewarm":false,"originY":0.85,"speed":900}}]}
```
