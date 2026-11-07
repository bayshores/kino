// Caption files beside a rendered video: name.srt and name.vtt with the times the captions are
// on screen in that video. Players and platforms can then show the captions as text (for screen
// readers, search, and viewers who turn burned-in text off) instead of only as pixels.
//
// The times are read from the scene the way the renderer shows it: components are drawn out
// (so captions inside a sequence's parts count), and each text layer with role "caption" is
// evaluated at every frame of the render. A caption event runs from the first frame it shows on
// to the first frame it is gone, so the files agree with the burned-in captions to the frame.
import { writeFile } from "node:fs/promises";
import { expandComponents } from "../../engine/linkedComponents.js";
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { formatSrt, formatVtt } from "../../engine/subtitles.js";

const SHOWN = 0.01;

/**
 * Caption events [{start, end, text}] of a scene at `fps` frames a second; [] without captions.
 * With `duration` (a render shorter than the scene), events are cut at that many seconds.
 */
export function captionEvents(document, sceneId, { fonts, fps = 30, duration } = {}) {
  const expanded = expandComponents(document, sceneId, { fonts });
  const byId = new Map(expanded.layers.map((layer) => [layer.id, layer]));
  // Only caption text and the groups around it are evaluated.
  const keep = new Set();
  for (const layer of expanded.layers) {
    if (layer.type !== "text" || layer.role !== "caption" || !String(layer.text ?? "").trim()) continue;
    for (let current = layer; current && !keep.has(current.id); current = byId.get(current.parentId)) keep.add(current.id);
  }
  if (!keep.size) return [];
  const scene = { ...expanded, layers: expanded.layers.filter((layer) => keep.has(layer.id)) };
  const model = kinoTimeline({ ...document, scenes: [scene] }, sceneId, { fonts, fps });
  const events = [];
  for (const item of model.items) {
    if (item.kind !== "text" || item.role !== "caption") continue;
    const opacity = item.samples.opacity;
    let first = -1;
    for (let index = 0; index <= model.times.length; index += 1) {
      const shown = index < model.times.length && opacity[index] > SHOWN;
      if (shown && first < 0) first = index;
      if (!shown && first >= 0) {
        const end = index < model.times.length ? model.times[index] : model.duration;
        events.push({ start: model.times[first], end, text: String(item.text).trim() });
        first = -1;
      }
    }
  }
  // The render's length, read the way export.mjs reads it (at least one frame).
  const length = duration != null && Number.isFinite(Number(duration)) ? Math.max(1 / fps, Number(duration)) : Infinity;
  return events
    .map((event) => ({ ...event, end: Math.min(event.end, length) }))
    .filter((event) => event.end > event.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Writes <video name>.srt and .vtt for the events. Returns the two paths. */
export async function writeCaptionFiles(videoPath, events) {
  const base = videoPath.replace(/\.[a-z0-9]+$/i, "");
  const files = [`${base}.srt`, `${base}.vtt`];
  await writeFile(files[0], formatSrt(events), { mode: 0o600 });
  await writeFile(files[1], formatVtt(events), { mode: 0o600 });
  return files;
}
