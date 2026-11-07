import { parentPort as threadPort } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";
import { blendRenderSamples, createSampleBlend, MAX_MOTION_SAMPLES } from "./render-quality.mjs";
import { frameReference } from "./render-output-audit.mjs";
import { encodeRenderPng } from "./render-png.mjs";
import { flattenTilts } from "./flatten-tilts.mjs";

const MAX_SVG_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;

// The pool runs this file as a child process (render-pool.mjs: a Resvg panic aborts only its own
// process, not the kino service) or, in tests, as a worker thread.
const parentPort = threadPort ?? (process.send ? {
  on: (event, listener) => process.on(event, listener),
  postMessage: (message) => process.send(message),
} : null);
if (!parentPort) throw new Error("The Resvg render worker needs a parent thread or process.");
if (!threadPort) process.on("disconnect", () => process.exit(0));

function conciseError(error) {
  const value = typeof error?.message === "string" ? error.message : "Resvg could not render this SVG.";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_LENGTH);
}

function transferableBytes(value) {
  // Resvg's N-API-backed buffers cannot be transferred directly. Copy byte-for-byte,
  // including the premultiplied RGBA pixels returned by render().
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes.buffer;
}

parentPort.on("message", async (request) => {
  const id = request?.id;
  try {
    const samples = request?.samples === undefined ? [] : request.samples;
    const dither = request?.dither === undefined ? false : request.dither;
    if (!Number.isSafeInteger(id) || id < 1 || typeof request.svg !== "string" ||
        !Array.isArray(samples) || samples.length > MAX_MOTION_SAMPLES - 1 || samples.some((sample) => typeof sample !== "string") ||
        Buffer.byteLength(request.svg, "utf8") + samples.reduce((bytes, sample) => bytes + Buffer.byteLength(sample, "utf8"), 0) > MAX_SVG_BYTES ||
        (request.raw !== true && request.raw !== false) || typeof dither !== "boolean" ||
        (request.raw && (samples.length > 0 || dither))) {
      throw new Error("The Resvg render request is invalid.");
    }

    // Each tilted layer's flat drawing is drawn once (flatten-tilts.mjs); a draft caps its bitmap
    // by the frame's size.
    const flat = (svg) => flattenTilts(svg, request.options ?? {}, { draft: request.draft === true });
    let rendered;
    let reference;
    let bytes;
    if (!request.raw && (samples.length > 0 || dither)) {
      const draw = async (svg) => {
        const image = new Resvg(await flat(svg), request.options ?? {}).render();
        return { pixels: image.pixels, width: image.width, height: image.height, premultiplied: true };
      };
      if (samples.length <= 1) rendered = blendRenderSamples(await Promise.all([request.svg, ...samples].map(draw)), { dither });
      else {
        // Many shutter samples: add each picture to one sum buffer instead of keeping them all.
        let blend;
        for (const svg of [request.svg, ...samples]) {
          const image = await draw(svg);
          blend ??= createSampleBlend(image.width, image.height);
          blend.add(image);
        }
        rendered = blend.finish({ dither });
      }
      bytes = await encodeRenderPng(rendered.pixels, rendered.width, rendered.height);
      const rgba = new Uint8Array(rendered.pixels.buffer, rendered.pixels.byteOffset, rendered.pixels.byteLength);
      reference = transferableBytes(frameReference(rgba, rendered.width, rendered.height));
    } else {
      rendered = new Resvg(await flat(request.svg), request.options ?? {}).render();
      bytes = request.raw ? rendered.pixels : rendered.asPng();
    }
    const data = transferableBytes(bytes);
    const transfer = [data];
    if (reference) transfer.push(reference);
    parentPort.postMessage({
      id,
      width: rendered.width,
      height: rendered.height,
      ...(request.raw ? { pixels: data } : { buffer: data }),
      ...(reference ? { reference } : {}),
    }, transfer);
  } catch (error) {
    parentPort.postMessage({ id, error: conciseError(error) });
  }
});

parentPort.postMessage({ type: "ready", version: 1 });
