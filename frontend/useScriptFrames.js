// Script layers on the live stage and in the share-link viewer. Each script layer the scene shows
// gets one sandboxed frame (scriptHost.js) that runs its module. When the time or the sampled
// values change, the frame is asked for a picture (at most one request in flight per layer);
// the ImageBitmap that comes back is painted into the layer's <canvas data-kino-script>, which the
// renderer places where an image layer would be (render.js, the `liveScripts` option).
// A module that fails or takes too long draws nothing until its script, size or images change.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { SCRIPT_FRAME_PATH, SCRIPT_LIBRARY_PATH, scriptLibraryNames } from "../engine/scriptLayer.js";
import { authorizedMediaUrl } from "./client.js";
import { createScriptHost } from "./scriptHost.js";
import { isLate, previewRatio, scriptLayersToDraw, scriptRequest, shouldSend } from "./scriptFrames.js";

const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;

// An image (or model) input's file, loaded by the page with the same address an image layer uses.
async function imageBytes(src, maxBytes = MAX_IMAGE_BYTES) {
  if (!src) return null;
  const response = await fetch(authorizedMediaUrl(src));
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  return bytes.byteLength <= maxBytes ? bytes : null;
}

// The library modules the script imports, as text, loaded once per page (the frame fetches nothing).
const libraryCache = new Map();
async function libraryTexts(script) {
  const texts = {};
  for (const name of scriptLibraryNames(script)) {
    if (!libraryCache.has(name)) libraryCache.set(name, fetch(`${SCRIPT_LIBRARY_PATH}?name=${encodeURIComponent(name)}`)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .catch((error) => { libraryCache.delete(name); throw error; }));
    texts[name] = await libraryCache.get(name);
  }
  // The model loader imports the library itself.
  if (texts["three/addons/loaders/GLTFLoader.js"] && !texts.three) return { ...texts, ...(await libraryTexts('import * as THREE from "three";')) };
  return texts;
}

/** Paints each layer's newest picture into its canvas (again only when the picture changed). */
export function paintScriptCanvases(container, slots) {
  for (const canvas of container?.querySelectorAll?.("canvas[data-kino-script]") ?? []) {
    const bitmap = slots.get(canvas.dataset.kinoScript)?.bitmap ?? null;
    if (canvas.kinoPainted === bitmap) continue;
    canvas.kinoPainted = bitmap;
    if (!bitmap) { canvas.width = 1; canvas.height = 1; continue; }
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
  }
}

/**
 * `container`: a ref to the element the scene's SVG is in. Returns {liveScripts: the Set of layer
 * ids to pass to renderSceneSvg, paint(): call after each patch of the SVG}.
 */
export function useScriptFrames(scene, time, { active = true, container } = {}) {
  const slots = useRef(new Map());
  const layers = useMemo(() => (active ? scriptLayersToDraw(scene.layers) : []), [scene, active]);
  const liveScripts = useMemo(() => new Set(layers.map((layer) => layer.id)), [layers]);
  const paint = useCallback(() => paintScriptCanvases(container.current, slots.current), [container]);

  // Sends the newest wish of one slot when it may go (scriptFrames.js shouldSend).
  const pump = useCallback((slot) => {
    const wanted = slot.wanted;
    if (!slot.host || !shouldSend(slot, wanted)) return;
    slot.pending = wanted;
    slot.host.draw(wanted.frame).then((reply) => {
      slot.pending = null;
      if (slot.gone) { reply.bitmap?.close(); return; }
      // Stopped along with a stuck module: the frame lost the mount, so it mounts again.
      if (reply.stopped) {
        slot.mounted = null;
        if (!slot.mounting && slot.wanted) void mount(slot, slot.wanted);
        return;
      }
      // An answer for a module that was replaced meanwhile.
      if (!reply.ok && slot.mounted !== wanted.mountKey) return pump(slot);
      if (!reply.ok) return fail(slot, wanted.mountKey);
      if (isLate(wanted, slot.wanted) || !reply.bitmap) reply.bitmap?.close();
      else {
        slot.bitmap?.close();
        slot.bitmap = reply.bitmap;
        slot.shownKey = wanted.key;
        paint();
      }
      pump(slot);
    });
  }, [paint]);

  // A failed or stuck module draws nothing until its mount changes. The frame stays (it stopped
  // a stuck module's Worker itself) unless it stopped answering and was thrown away.
  const fail = useCallback((slot, mountKey) => {
    slot.failedKey = mountKey;
    if (slot.host?.destroyed) slot.host = null;
    slot.mounted = null;
    slot.bitmap?.close();
    slot.bitmap = null;
    slot.shownKey = null;
    paint();
  }, [paint]);

  const mount = useCallback(async (slot, wanted) => {
    slot.mounted = null;
    slot.mounting = wanted.mountKey;
    // One frame per layer for as long as the layer is shown; a new module mounts in the same one.
    if (!slot.host || slot.host.destroyed) slot.host = createScriptHost({ src: SCRIPT_FRAME_PATH });
    const host = slot.host;
    slot.mountId = (slot.mountId ?? 0) + 1;
    const mountId = slot.mountId;
    const images = {}, models = {};
    let libraries = {};
    try {
      for (const [key, src] of Object.entries(wanted.mount.images)) images[key] = await imageBytes(src);
      for (const [key, src] of Object.entries(wanted.mount.models ?? {})) models[key] = await imageBytes(src, MAX_MODEL_BYTES);
      libraries = await libraryTexts(wanted.mount.script);
    } catch {
      // A picture or model that cannot be loaded is none, as for an image layer.
    }
    // A newer mount started meanwhile: this one's answer no longer counts.
    const stale = () => slot.mountId !== mountId || slot.gone;
    if (stale()) return;
    const reply = await host.mount({ ...wanted.mount, images, models, libraries });
    if (stale()) return;
    slot.mounting = null;
    // Stopped along with an older module that got stuck: this one has done nothing wrong.
    if (reply.stopped) return mount(slot, wanted);
    if (!reply.ok) return fail(slot, wanted.mountKey);
    slot.mounted = wanted.mountKey;
    pump(slot);
  }, [fail, pump]);

  useEffect(() => {
    const ids = new Set(layers.map((layer) => layer.id));
    for (const [id, slot] of slots.current) {
      if (ids.has(id)) continue;
      slot.gone = true;
      slot.host?.destroy();
      slot.bitmap?.close();
      slots.current.delete(id);
    }
    if (!layers.length) return;
    const box = container.current;
    const stagePixels = box?.clientWidth ? box.clientWidth * (globalThis.devicePixelRatio || 1) : 0;
    const pixelRatio = previewRatio(stagePixels, Number(scene.width) || 0);
    for (const layer of layers) {
      let slot = slots.current.get(layer.id);
      if (!slot) { slot = { host: null, mounted: null, pending: null, bitmap: null }; slots.current.set(layer.id, slot); }
      const wanted = scriptRequest(layer, time, { sceneDuration: Number(scene.duration) || 0, pixelRatio });
      slot.wanted = wanted;
      if (slot.failedKey === wanted.mountKey) continue;
      if (slot.mounted !== wanted.mountKey && slot.mounting !== wanted.mountKey) void mount(slot, wanted);
      else pump(slot);
    }
  }, [layers, time, scene, container, mount, pump]);

  // Everything goes when the preview goes.
  useEffect(() => () => {
    for (const slot of slots.current.values()) { slot.gone = true; slot.host?.destroy(); slot.bitmap?.close(); }
    slots.current.clear();
  }, []);

  return { liveScripts, paint };
}
