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
  const spans = [];
  for (const item of model.items) {
    if (item.kind !== "text" || item.role !== "caption") continue;
    const opacity = item.samples.opacity;
    const layer = byId.get(item.id);
    let first = -1;
    for (let index = 0; index <= model.times.length; index += 1) {
      const shown = index < model.times.length && opacity[index] > SHOWN;
      if (shown && first < 0) first = index;
      if (!shown && first >= 0) {
        const end = index < model.times.length ? model.times[index] : model.duration;
        spans.push({ start: model.times[first], end, text: String(item.text).trim(), parentId: item.parentId, x: layer?.x ?? 0, y: layer?.y ?? 0, size: layer?.fontSize ?? 48 });
        first = -1;
      }
    }
  }
  const events = phraseEvents(spans);
  // The render's length, read the way export.mjs reads it (at least one frame).
  const length = duration != null && Number.isFinite(Number(duration)) ? Math.max(1 / fps, Number(duration)) : Infinity;
  return events
    .map((event) => ({ ...event, end: Math.min(event.end, length) }))
    .filter((event) => event.end > event.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

// Phrase looks draw one text layer per word inside a phrase group: words of one group on screen
// together are one event, in reading order (lines top to bottom, words left to right).
function phraseEvents(spans) {
  const events = [];
  const byParent = new Map();
  for (const span of spans) {
    if (!span.parentId) { events.push(span); continue; }
    if (!byParent.has(span.parentId)) byParent.set(span.parentId, []);
    byParent.get(span.parentId).push(span);
  }
  for (const group of byParent.values()) {
    group.sort((a, b) => a.start - b.start);
    const clusters = [];
    for (const span of group) {
      const last = clusters.at(-1);
      if (last && span.start < last.end) { last.items.push(span); last.end = Math.max(last.end, span.end); }
      else clusters.push({ start: span.start, end: span.end, items: [span] });
    }
    for (const { start, end, items } of clusters) {
      items.sort((a, b) => (Math.abs(a.y - b.y) > a.size / 2 ? a.y - b.y : a.x - b.x));
      const lines = [];
      for (const item of items) {
        const line = lines.at(-1);
        if (line && Math.abs(line.y - item.y) <= item.size / 2) line.words.push(item.text);
        else lines.push({ y: item.y, words: [item.text] });
      }
      events.push({ start, end, text: lines.map((line) => line.words.join(" ")).join("\n") });
    }
  }
  return events.map(({ start, end, text }) => ({ start, end, text }));
}

/** Writes <video name>.srt and .vtt for the events. Returns the two paths. */
export async function writeCaptionFiles(videoPath, events) {
  const base = videoPath.replace(/\.[a-z0-9]+$/i, "");
  const files = [`${base}.srt`, `${base}.vtt`];
  await writeFile(files[0], formatSrt(events), { mode: 0o600 });
  await writeFile(files[1], formatVtt(events), { mode: 0o600 });
  return files;
}
