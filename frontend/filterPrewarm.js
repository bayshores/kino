import { useEffect, useRef } from "react";
import { renderSceneSvg } from "../engine/render.js";
import { INITIAL_VIDEO_FRAME } from "./videoPreview.js";

// The graphics card builds a program the first time it draws a new kind of filter (a blur of a
// new size, a blend mode, a mask). In a playing scene that froze the picture for 0.2 to 2 s where
// a filter first showed. So after a scene loads or changes, the live preview looks through the
// scene every SAMPLE_SECONDS for filters it has not drawn yet and draws each such moment once,
// nearly see-through, before it plays.
const SAMPLE_SECONDS = 0.25;
// Main-thread time one idle slice may spend drawing samples (ms).
const SLICE_MS = 8;

// What decides which programs a filter needs: its steps and the rough size of each number
// (a blur of 24 and of 26 share one, 3 and 24 do not), without ids or the filter's area.
function bucket(number) {
  const value = Math.abs(Number(number));
  return Number.isFinite(value) ? Math.round(Math.log2(value + 1)) : 0;
}

/** The kinds of filter, blend and mask a scene SVG draws, as a set of short keys. */
export function filterKinds(svg) {
  const kinds = new Set();
  for (const [filter] of svg.matchAll(/<filter\b[^>]*>[\s\S]*?<\/filter>/g)) {
    kinds.add(filter
      .replace(/<filter\b[^>]*>/, "<filter>")
      .replace(/\s(?:id|result|in|in2|href)="[^"]*"/g, "")
      .replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (number) => String(bucket(number))));
  }
  for (const [blend] of svg.matchAll(/mix-blend-mode:\s*[\w-]+/g)) kinds.add(blend);
  if (/<mask\b/.test(svg)) kinds.add("mask");
  return kinds;
}

const idle = (callback) => (globalThis.requestIdleCallback
  ? requestIdleCallback(callback, { timeout: 200 })
  : setTimeout(() => callback({ timeRemaining: () => SLICE_MS }), 16));
const cancelIdle = (handle) => (globalThis.cancelIdleCallback ? cancelIdleCallback(handle) : clearTimeout(handle));

/**
 * Pre-draws each new filter kind of `scene` into the element `warm` (a ref), off to the side of
 * the stage's own picture. Videos are drawn as a still picture here: the filter programs are the
 * same. Only the live preview uses this; exports never do.
 *
 * `skip(time)`, when given, is true at the moments this picture never shows, which are then not
 * pre-drawn either. The stage draws light rays on a smaller picture of its own on a large stage
 * (dashboard/liveResolution.js); pre-drawing them in the full-resolution picture took one frame
 * of 3.6 s on a computer that draws on the CPU, the slow frame the smaller picture is there to avoid.
 */
export function useFilterPrewarm(warm, scene, { active, options, skip }) {
  const latest = useRef(options);
  latest.current = options;
  const skipped = useRef(skip);
  skipped.current = skip;
  useEffect(() => {
    if (!active || !scene?.layers?.length) return undefined;
    let cancelled = false, handle = null, frame = null;
    const videoFrames = new Map(scene.layers.filter((layer) => layer.type === "video").map((layer) => [layer.id, INITIAL_VIDEO_FRAME]));
    const svgAt = (time) => {
      try { return renderSceneSvg(scene, time, { ...latest.current, design: false, canvas: false, interactiveMedia: false, videoFrames }); }
      catch { return ""; }
    };
    const seen = new Set(), queue = [];
    const duration = Number(scene.duration) || 0;
    let time = 0;
    // Draws the queued moments one per two display frames, then clears the element.
    const show = () => {
      if (cancelled) return;
      const element = warm.current;
      if (!element) return;
      const next = queue.shift();
      if (next === undefined) { element.replaceChildren(); frame = null; return; }
      element.innerHTML = next;
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(show); });
    };
    const work = (deadline) => {
      if (cancelled) return;
      const until = performance.now() + Math.min(SLICE_MS, Math.max(2, deadline.timeRemaining()));
      while (time <= duration && performance.now() < until) {
        if (skipped.current?.(time)) { time += SAMPLE_SECONDS; continue; }
        const svg = svgAt(time);
        let fresh = false;
        for (const kind of filterKinds(svg)) if (!seen.has(kind)) { seen.add(kind); fresh = true; }
        if (fresh) queue.push(svg);
        time += SAMPLE_SECONDS;
      }
      if (queue.length && frame === null) show();
      if (time <= duration) handle = idle(work);
    };
    handle = idle(work);
    return () => {
      cancelled = true;
      if (handle !== null) cancelIdle(handle);
      if (frame !== null) cancelAnimationFrame(frame);
      warm.current?.replaceChildren();
    };
  }, [warm, scene, active]);
}
