// Lottie and the overlay generators (engine/effects/particles.js: embers, snow, fog, …).
//
// A generator is exported to Lottie like every other effect: as an embedded raster image
// sequence (lottie-effect-plan.mjs, lottie-raster-sequences.mjs), so the Lottie file shows the
// same particles kino draws. A looping generator repeats the same pictures, and identical frames
// are stored once. Two cases cannot be faithful, so they are refused before any frame is drawn,
// with the reason and what to change:
// - Blend: lottie-web has no add (linear dodge) blend, and the Lottie writer draws every other
//   blend as normal. Particles laid on with add would lose their glow and cover what is below.
// - Size: the frames would not fit the raster limit (64 million pixels across distinct frames).
import { effectsAt } from "../engine/effects/animation.js";
import { CLOCK_TICKS, PARTICLE_LOOKS } from "../engine/effects/particles.js";
import { DEFAULT_RASTER_SEQUENCE_LIMITS } from "./lottie-raster-sequences.mjs";

const ALTERNATIVES = "export a video (mp4, webm or mov), GIF, APNG or PNG instead";

/**
 * Returns why the scene's generators cannot go into a Lottie file faithfully, or null.
 * `times` are the Lottie frame times and `density` the raster scale (imageDPIRatio).
 */
export function lottieParticleProblem(scene, { times, fps, density, limits = DEFAULT_RASTER_SEQUENCE_LIMITS }) {
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const chain = (layer) => {
    const layers = [];
    const seen = new Set();
    for (let current = layer; current && !seen.has(current.id); current = byId.get(current.parentId)) {
      seen.add(current.id);
      layers.push(current);
    }
    return layers;
  };
  let pixels = 0;
  for (const layer of scene.layers) {
    const layers = chain(layer);
    if (layers.some((item) => item.visible === false)) continue;
    // The generators this layer shows at some frame, and a key for each frame's generator picture.
    const names = new Set(), pictures = new Set();
    for (const time of times.slice(0, -1)) {
      const samples = effectsAt(layer, time).filter((sample) => PARTICLE_LOOKS[sample.effect.key]);
      for (const sample of samples) names.add(sample.effect.label);
      // The generator's own clock (particles.js): ticks of 1/1200 s, counted from 0 again every loop.
      pictures.add(JSON.stringify(samples.map(({ effect, parameters, time: clock }) => {
        const ticks = Math.round(clock * CLOCK_TICKS), period = Math.max(1, Math.round(parameters.loop * CLOCK_TICKS));
        return [effect.key, parameters, parameters.loop > 0 ? ticks % period : ticks];
      })));
    }
    if (!names.size) continue;
    const what = `${[...names].join(", ")} on layer “${layer.name ?? layer.id}”`;
    const blended = layers.find((item) => item.blendMode && item.blendMode !== "normal");
    if (blended) {
      const where = blended === layer ? "the layer uses" : `its group “${blended.name ?? blended.id}” uses`;
      return `Lottie cannot show ${what} faithfully: ${where} the ${blended.blendMode} blend, which a Lottie file draws as normal (lottie-web has no add blend), so the particles would cover what is below instead of mixing with it. Set blendMode "normal" for the Lottie export, or ${ALTERNATIVES}.`;
    }
    // Each distinct picture is one PNG at the layer's size × density (a lower bound: other
    // animations on the layer can only make more distinct frames).
    const width = Math.max(1, Math.round(((layer.width ?? 0) + 2) * density));
    const height = Math.max(1, Math.round(((layer.height ?? 0) + 2) * density));
    pixels += pictures.size * width * height;
    if (pixels > limits.maxPixels)
      return `Lottie cannot hold ${what}: ${pictures.size} distinct frames of ${width}×${height} pixels (${fps} fps, ${density}× resolution) is more than the ${limits.maxPixels.toLocaleString("en-US")}-pixel limit for embedded frames. Give the generator a loop (a 1 s loop stores ${fps} frames), make the layer smaller, use imageDPIRatio "original", a lower fps or a shorter scene, or ${ALTERNATIVES}.`;
  }
  return null;
}
