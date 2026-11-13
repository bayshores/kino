# Script layers

Contents: The module, Inputs, Pure drawing, three examples (bars, a ring meter, a dot field).

A `script` layer's picture is drawn by a small JavaScript module you write. Its `inputs` are
typed values that you, and animations, change without touching the code. Use one for a
picture no preset makes: a chart that grows, a generative pattern, a custom meter.

Status: `look` frames and renders draw the module; the dashboard preview does not yet (the
layer shows empty there).

## The module

```js
export default function setup(layer) {           // runs once; may be async
  const ctx = layer.canvas.getContext("2d");     // or "webgl2"
  return function draw(frame) {                  // runs every frame; may be async
    ctx.fillStyle = frame.values.tint.css;
    ctx.fillRect(0, 0, frame.width * frame.progress, frame.height);
  };
}
```

- `layer`: `{canvas, width, height, pixelRatio, name}`. The canvas has
  `round(width * pixelRatio)` by `round(height * pixelRatio)` pixels.
- `frame`: `{time, duration, progress, values, width, height, pixelRatio}`. `time` is seconds
  since the layer showed, `duration` how long it shows, `progress` is `time / duration` (0 to 1).
- With a 2D context the canvas is cleared and scaled by `pixelRatio` before every draw: draw one
  whole frame in layer pixels. With WebGL the canvas is only sized.
- One module, at most 65,536 characters, with `export default`. The only imports are the 3D
  library and its model loader (the script-3d reference). A syntax error is refused at save.

## Inputs

`inputs` is a list (its order is the display order), at most 40. Each is
`{key, type, label?, min?, max?, step?, options?}`; `key` is like `reveal` or `barColor`.
`values` holds the current value of every input.

| type | value | in `frame.values` | animates |
| --- | --- | --- | --- |
| `number` | a number within `min`..`max` | a number | yes |
| `color` | `"#RRGGBB"` or `"#RRGGBBAA"` | `{r, g, b, a, css}`, channels 0..1 | yes |
| `text` | up to 2,000 characters | text | no |
| `boolean` | `true` or `false` | a boolean | no |
| `select` | one of `options` (2 to 24 texts) | text | no |
| `image` | an imported picture's `src`, or `""` | a bitmap, or `null` | no |
| `model` | an imported `.glb` file's `src`, or `""` | an `ArrayBuffer`, or `null` | no |

```text
update_layer {layer:"bars", properties:{values:{reveal:0.5}}}    merges into values
update_layer {layer:"bars", properties:{script:"..."}}           new code, same inputs
add_animation {layer:"bars", animation:{kind:"custom", start:0, duration:1.2, easing:"ease-out",
  from:{values:{reveal:0}}, to:{values:{reveal:1}}}}
```

New `inputs` drop the values of removed keys; removing one an animation moves is refused with
that animation's name. Only number and color inputs animate.

## Pure drawing

- The same frame gives the same pixels, in any order: seeking backward is normal. Work from
  `frame.time` and `frame.values`, never from what the last draw left.
- `Math.random` is seeded again before every draw, and `Date.now` and `performance.now`
  give `frame.time * 1000`. No network, storage, app access or `requestAnimationFrame`; timers
  end with the draw. Limits: setup 5 s, one draw 2 s.

## What you hear when it fails

A frame that throws or runs too long draws nothing for that layer. `look` adds a line such as
`script layer "bars": ReferenceError: x is not defined at 1.20 s (draw)` (the phase is load,
setup or draw), a draft render carries it as a warning, and a final render is refused with it.
Fix the module with `update_layer {properties:{script}}` and look at that time again.

- The edit receipt draws a layer you added or changed at its start, middle and end (small), and
  adds a warning line only for a problem: `script "bars": ReferenceError: x is not defined at
  1.20 s (draw, line 4)`, or `script "bars" drew nothing at 0.00 s, 1.00 s and 2.00 s`. No line
  means all three drew. The edit is saved either way.
- `check` has `script_layer_error` (an error: blocks a final render; fix is `update_layer` with a
  new `script`) and `script_layer_empty` (a warning: a shown layer drew nothing at any checked
  frame; a reveal that starts empty is fine). A refused script edit ends with a script layer example to resend.

## Example: bars that grow

Each example is the module, then the edit op that adds it (the same module as one JSON string).

```js
export default function setup(layer) {
  const ctx = layer.canvas.getContext("2d");
  const heights = [0.4, 0.7, 0.55, 0.9, 0.65];
  return function draw(frame) {
    const gap = 16, width = (frame.width - gap * (heights.length - 1)) / heights.length;
    ctx.fillStyle = frame.values.tint.css;
    heights.forEach((share, index) => {
      const height = frame.height * share * frame.values.reveal;
      ctx.fillRect(index * (width + gap), frame.height - height, width, height);
    });
  };
}
```

```json
{"op":"add_layer","layerType":"script","name":"bars","properties":{"x":160,"y":200,"width":800,"height":500,"script":"export default function setup(layer) {\n  const ctx = layer.canvas.getContext(\"2d\");\n  const heights = [0.4, 0.7, 0.55, 0.9, 0.65];\n  return function draw(frame) {\n    const gap = 16, width = (frame.width - gap * (heights.length - 1)) / heights.length;\n    ctx.fillStyle = frame.values.tint.css;\n    heights.forEach((share, index) => {\n      const height = frame.height * share * frame.values.reveal;\n      ctx.fillRect(index * (width + gap), frame.height - height, width, height);\n    });\n  };\n}\n","inputs":[{"key":"reveal","type":"number","min":0,"max":1},{"key":"tint","type":"color"}],"values":{"reveal":1,"tint":"#ff7a45"}}}
```

## Example: a ring meter with a label

```js
export default function setup(layer) {
  const ctx = layer.canvas.getContext("2d");
  return function draw(frame) {
    const { amount, ring, label } = frame.values;
    const size = Math.min(frame.width, frame.height), middle = size / 2;
    ctx.lineWidth = size * 0.08;
    ctx.strokeStyle = ring.css;
    ctx.beginPath();
    ctx.arc(middle, middle, middle * 0.8, -Math.PI / 2, -Math.PI / 2 + amount * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${size * 0.16}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(label, middle, middle + size * 0.05);
  };
}
```

```json
{"op":"add_layer","layerType":"script","name":"meter","properties":{"x":700,"y":300,"width":480,"height":480,"script":"export default function setup(layer) {\n  const ctx = layer.canvas.getContext(\"2d\");\n  return function draw(frame) {\n    const { amount, ring, label } = frame.values;\n    const size = Math.min(frame.width, frame.height), middle = size / 2;\n    ctx.lineWidth = size * 0.08;\n    ctx.strokeStyle = ring.css;\n    ctx.beginPath();\n    ctx.arc(middle, middle, middle * 0.8, -Math.PI / 2, -Math.PI / 2 + amount * Math.PI * 2);\n    ctx.stroke();\n    ctx.fillStyle = \"#ffffff\";\n    ctx.font = `600 ${size * 0.16}px sans-serif`;\n    ctx.textAlign = \"center\";\n    ctx.fillText(label, middle, middle + size * 0.05);\n  };\n}\n","inputs":[{"key":"amount","type":"number","min":0,"max":1,"step":0.01},{"key":"ring","type":"color","label":"Ring"},{"key":"label","type":"text"}],"values":{"amount":0.72,"ring":"#3ddc97","label":"72%"}}}
```

## Example: a seeded dot field

```js
export default function setup(layer) {
  const ctx = layer.canvas.getContext("2d");
  return function draw(frame) {
    const { count, shape, drift } = frame.values;
    ctx.fillStyle = "#f4f6fb";
    for (let index = 0; index < count; index++) {
      const x = Math.random() * frame.width;
      const y = (Math.random() * frame.height + (drift ? frame.time * 40 : 0)) % frame.height;
      if (shape === "square") ctx.fillRect(x, y, 6, 6);
      else { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
    }
  };
}
```

```json
{"op":"add_layer","layerType":"script","name":"dots","properties":{"x":0,"y":0,"width":1920,"height":1080,"script":"export default function setup(layer) {\n  const ctx = layer.canvas.getContext(\"2d\");\n  return function draw(frame) {\n    const { count, shape, drift } = frame.values;\n    ctx.fillStyle = \"#f4f6fb\";\n    for (let index = 0; index < count; index++) {\n      const x = Math.random() * frame.width;\n      const y = (Math.random() * frame.height + (drift ? frame.time * 40 : 0)) % frame.height;\n      if (shape === \"square\") ctx.fillRect(x, y, 6, 6);\n      else { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }\n    }\n  };\n}\n","inputs":[{"key":"count","type":"number","min":0,"max":2000,"step":1},{"key":"shape","type":"select","options":["circle","square"]},{"key":"drift","type":"boolean"}],"values":{"count":400,"shape":"circle","drift":true}}}
```
