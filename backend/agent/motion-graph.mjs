// look {mode:"motion"}: how a scene moves, read from the quality model (no rendering), so an
// agent that cannot watch video can still see a push, a dip or a sliver at the frame edge.
//
// motionTrace(model, options) measures every sample (30 a second) from `from` to `to`:
//   cover   how much of the frame full-frame pictures and fills cover (1 = no gap to the
//           scene background; a dip between two plates shows the background through)
//   plate   the topmost full-frame plate, with its scale rate (share a second) and speed
//           (frame widths a second): a camera push moves the plate
//   mover   the largest other picture that moves, with its scale rate, speed and frame share
//   edge    the largest sliver at the frame edge, measured as edge_linger does (edgeSliver in
//           engine/quality/rules/camera.js)
//   cuts    where the top plate changes in one frame
// and turns that into a short text trace (one line a 0.5 s step, quiet steps merged) and a
// graph PNG (motionGraphImage) with cuts, beats, cues and check findings marked. The verdicts
// (a lone push, a dip, a sliver lingering, a cut mid-move) are the camera rules' findings, passed
// in by the caller: this file only measures, so the trace and check never disagree.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { area, boxAt, frameAt, intersection, visibleBoxAt } from "../../engine/quality/model.js";
import { edgeLayers, edgeSliver } from "../../engine/quality/rules/camera.js";
import { BACKGROUND_OWNER_ID } from "../../engine/sceneBackground.js";

export const TRACE_STEP = 0.5;
// A plate covers at least this share of the frame.
const PLATE_SHARE = 0.95;
// Below these a layer counts as still: scale rate (share a second) and speed (widths a second).
export const STILL_SCALE = 0.03;
export const STILL_SPEED = 0.02;
// A sliver at the edge is noted in the text when it lasts this long in a step (a fast slide
// crosses the edge in a frame or two: noise).
export const EDGE_NOTE = 0.1;
// The camera rules, whose findings are the trace's verdicts.
export const CAMERA_RULES = new Set(["lone_zoom", "edge_linger", "transition_dip", "cut_mid_move"]);
// The text trace stops near this many characters (about 2k tokens) and says how to see the rest.
export const TRACE_CHARS = 7000;

const pct = (value) => `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%/s`;
const fixed = (value, digits = 2) => value.toFixed(digits);

/**
 * The per-sample motion of a model between `from` and `to` (seconds). `name(item)` names a layer
 * the way the agent refers to it. Returns { fps, times, cover, plate, mover, edge, cuts }.
 */
export function motionTrace(model, { from = 0, to = model.duration, name = (item) => item.name } = {}) {
  const fps = model.fps;
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const frameArea = model.width * model.height;
  const share = (box) => area(intersection(box, frame)) / frameArea;
  const pictures = model.items.filter((item) => !item.isMask && item.kind !== "group" && item.kind !== "audio" && item.kind !== "text" && item.id !== BACKGROUND_OWNER_ID && item.painted);
  const first = frameAt(model, from), last = Math.max(first, frameAt(model, to));
  const count = model.times.length;
  // Scale rate and speed of an item at sample i (forward difference, backward at the end).
  const rates = (item, i) => {
    const a = i + 1 < count ? i : i - 1, b = a + 1;
    if (a < 0) return { scale: 0, speed: 0 };
    const p = boxAt(item, a), q = boxAt(item, b);
    const grow = Math.sqrt(Math.max(1, area(q)) / Math.max(1, area(p)));
    const dx = (q.x0 + q.x1 - p.x0 - p.x1) / 2, dy = (q.y0 + q.y1 - p.y0 - p.y1) / 2;
    return { scale: (grow - 1) * fps, speed: (Math.hypot(dx, dy) * fps) / model.width };
  };
  const { items: edgeItems, coverers } = edgeLayers(model);
  const out = { fps, times: [], cover: [], plate: [], mover: [], edge: [], cuts: [] };
  let previousPlate = null;
  for (let i = first; i <= last; i += 1) {
    let through = 1, plate = null, mover = null, edge = null;
    for (const item of pictures) {
      const opacity = item.samples.opacity[i];
      if (opacity < 0.05) continue;
      const seen = visibleBoxAt(model, item, i);
      const onFrame = share(seen);
      if (item.opaque && onFrame >= PLATE_SHARE) {
        through *= 1 - Math.min(1, opacity);
        if (opacity >= 0.5 && (!plate || item.z > plate.item.z)) plate = { item, ...rates(item, i) };
        continue;
      }
      if (opacity < 0.3 || onFrame < 0.01) continue;
      const moving = rates(item, i);
      if (Math.abs(moving.scale) < STILL_SCALE && moving.speed < STILL_SPEED) continue;
      if (!mover || onFrame > mover.share) mover = { item, share: onFrame, ...moving };
    }
    for (const item of edgeItems) {
      const sliver = edgeSliver(model, item, i, coverers);
      if (sliver && (!edge || sliver.share > edge.share)) edge = { item, share: sliver.share };
    }
    const time = model.times[i];
    // A cut: the top plate changes in one frame, because the new one snaps in or the old one
    // snaps out (a dissolve changes it gradually and is not a cut).
    if (plate && previousPlate && plate.item !== previousPlate.item) {
      const opacity = (entry, at) => entry.item.samples.opacity[at];
      const snappedIn = opacity(plate, i - 1) < 0.05;
      const snappedOut = opacity(previousPlate, i - 1) >= 0.95 && opacity(previousPlate, i) < 0.05;
      if (snappedIn || snappedOut) out.cuts.push({ time, from: name(previousPlate.item), to: name(plate.item) });
    }
    previousPlate = plate;
    out.times.push(time);
    out.cover.push(1 - through);
    out.plate.push(plate ? { name: name(plate.item), scale: plate.scale, speed: plate.speed } : null);
    out.mover.push(mover ? { name: name(mover.item), scale: mover.scale, speed: mover.speed, share: mover.share } : null);
    out.edge.push(edge ? { name: name(edge.item), share: edge.share } : null);
  }
  return out;
}

/**
 * The trace as text an agent reads: one line a TRACE_STEP, quiet steps merged into one line.
 * `marks` are [{time, words}] (cues, findings) noted on the step they fall in; `findings` are the
 * camera rules' findings ({rule, severity, at, until, message}), each noted in full on the step
 * it starts in.
 */
export function traceText(trace, { marks = [], findings = [], step = TRACE_STEP } = {}) {
  const lines = [];
  const steps = [];
  const start = trace.times[0] ?? 0, end = trace.times.at(-1) ?? 0;
  for (let at = start; at <= end + 1e-6; at += step) {
    const indexes = trace.times.map((time, i) => [time, i]).filter(([time]) => time >= at - 1e-6 && time < at + step - 1e-6).map(([, i]) => i);
    if (!indexes.length) continue;
    const cover = Math.min(...indexes.map((i) => trace.cover[i]));
    // The busiest sample stands for the step: the fastest-scaling or fastest mover.
    const busiest = indexes.reduce((best, i) => {
      const m = trace.mover[i], b = trace.mover[best];
      const score = m ? Math.abs(m.scale) + m.speed : -1, bestScore = b ? Math.abs(b.scale) + b.speed : -1;
      return score > bestScore ? i : best;
    }, indexes[0]);
    const plateIndex = indexes.reduce((best, i) => (Math.abs(trace.plate[i]?.scale ?? 0) + (trace.plate[i]?.speed ?? 0) > Math.abs(trace.plate[best]?.scale ?? 0) + (trace.plate[best]?.speed ?? 0) ? i : best), indexes[0]);
    const plate = trace.plate[plateIndex], mover = trace.mover[busiest];
    const edge = indexes.map((i) => trace.edge[i]).filter(Boolean).sort((a, b) => b.share - a.share)[0];
    const edgeFrames = indexes.filter((i) => trace.edge[i]).length;
    const notes = [];
    for (const cut of trace.cuts) if (cut.time >= at - 1e-6 && cut.time < at + step - 1e-6) notes.push(`cut ${cut.time.toFixed(2)}s ${cut.from}>${cut.to}`);
    // A finding starting before the trace is noted on its first step.
    for (const finding of findings) {
      const first = Math.max(finding.at, start);
      if (first < at - 1e-6 || first >= at + step - 1e-6) continue;
      const span = finding.until != null ? `${finding.at}-${finding.until}s` : `${finding.at}s`;
      notes.push(`${finding.severity === "error" ? "E" : "W"} ${finding.rule} ${span}: ${finding.message.split(/: | while /)[0]}`);
    }
    if (edge && edgeFrames / trace.fps >= EDGE_NOTE - 1e-6) notes.push(`edge ${edge.name} ${(edge.share * 100).toFixed(1)}% of frame for ${(edgeFrames / trace.fps).toFixed(2)}s`);
    // Findings ("W rule", "E rule") share one note a step: "W: hold judder".
    const inStep = marks.filter((mark) => mark.time >= at - 1e-6 && mark.time < at + step - 1e-6);
    for (const level of ["E", "W"]) {
      const rules = [...new Set(inStep.filter((mark) => mark.words.startsWith(`${level} `)).map((mark) => mark.words.slice(2)))];
      if (rules.length) notes.push(`${level}: ${rules.join(" ")}`);
    }
    for (const mark of inStep) if (!/^[EW] /.test(mark.words)) notes.push(mark.words);
    const plateWords = plate ? `${plate.name} ${Math.abs(plate.scale) < STILL_SCALE && plate.speed < STILL_SPEED ? "still" : `${pct(plate.scale)} ${fixed(plate.speed)}w/s`}` : "none";
    // Quiet: nothing moves and nothing to note; steps with the same plate and cover merge.
    const quiet = !mover && !notes.length;
    const still = `${cover < 0.98 ? `cover ${fixed(cover)} | ` : ""}plate ${plateWords}`;
    steps.push({ at, quiet, still, cover, line: `${fixed(at, 1)} cover ${fixed(cover)} | plate ${plateWords} | ${mover ? `mover ${mover.name} ${pct(mover.scale)} ${fixed(mover.speed)}w/s ${Math.round(mover.share * 100)}%` : "no mover"}${notes.length ? ` | ${notes.join("; ")}` : ""}` });
  }
  for (let index = 0; index < steps.length; index += 1) {
    const entry = steps[index];
    if (!entry.quiet) { lines.push(entry.line); continue; }
    let stop = index;
    while (stop + 1 < steps.length && steps[stop + 1].quiet && steps[stop + 1].still === entry.still) stop += 1;
    lines.push(stop > index ? `${fixed(entry.at, 1)}-${fixed(Math.min(end, steps[stop].at + step), 1)} quiet | ${entry.still}` : entry.line);
    index = stop;
  }
  let text = "", cutAt = null;
  for (const line of lines) {
    if (text.length + line.length + 1 > TRACE_CHARS) { cutAt = Number(line.split(/[ -]/)[0]); break; }
    text += `${text ? "\n" : ""}${line}`;
  }
  return { text, more: cutAt };
}

const labelFont = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts/Inter-600.ttf");
let fontReady = false;
const INK = { cover: "#ffffff", plate: "#2ec4b6", mover: "#ff7a59", edge: "#ffd23f", cut: "#ffffff", beat: "#5b6070", cue: "#7fb7ff", finding: "#ffd23f", grid: "#2a2d35", text: "#b8bcc4" };
// The lane a camera finding's span is shaded on (red): lone_zoom on scale, edge_linger on edge,
// transition_dip on cover, cut_mid_move on speed.
const FINDING_LANE = { transition_dip: 0, lone_zoom: 1, cut_mid_move: 2, edge_linger: 3 };

/**
 * The graph: four lanes over time (cover; scale rate of plate and mover; their speed; edge
 * sliver share) with cuts, beats, cues and findings marked. `marks` are [{time, kind, words}]
 * with kind "beat", "cue" or "finding"; `findings` (the camera rules') shade their span red on
 * their lane. Returns a PNG buffer.
 */
export function motionGraphImage(trace, { marks = [], findings = [], width = 1200 } = {}) {
  if (!fontReady) { try { GlobalFonts.registerFromPath(labelFont, "kino-label"); } catch { /* default font */ } fontReady = true; }
  const lanes = [
    { title: "cover (0-1)", max: 1, series: [{ color: INK.cover, value: (i) => trace.cover[i] }] },
    { title: "scale rate |%/s| plate / mover (0-150)", max: 1.5, series: [{ color: INK.plate, value: (i) => Math.abs(trace.plate[i]?.scale ?? 0) }, { color: INK.mover, value: (i) => Math.abs(trace.mover[i]?.scale ?? 0) }] },
    { title: "speed (frame widths/s) plate / mover (0-2)", max: 2, series: [{ color: INK.plate, value: (i) => trace.plate[i]?.speed ?? 0 }, { color: INK.mover, value: (i) => trace.mover[i]?.speed ?? 0 }] },
    { title: "edge: sliver % of frame (0-15)", max: 0.15, fill: true, series: [{ color: INK.edge, value: (i) => trace.edge[i]?.share ?? 0 }] },
  ];
  const left = 12, right = 12, top = 52, laneHeight = 110, laneGap = 26, axis = 30;
  const height = top + lanes.length * (laneHeight + laneGap) + axis;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#101114";
  context.fillRect(0, 0, width, height);
  const start = trace.times[0] ?? 0, end = Math.max(start + 1 / trace.fps, trace.times.at(-1) ?? 0);
  const x = (time) => left + ((time - start) / (end - start)) * (width - left - right);
  context.font = "14px kino-label, sans-serif";
  // Lanes with their lines.
  lanes.forEach((lane, index) => {
    const y0 = top + index * (laneHeight + laneGap), y1 = y0 + laneHeight;
    context.fillStyle = "#16181d";
    context.fillRect(left, y0, width - left - right, laneHeight);
    context.fillStyle = INK.text;
    context.fillText(lane.title, left + 4, y0 - 6);
    for (const series of lane.series) {
      context.strokeStyle = series.color;
      context.fillStyle = series.color;
      context.lineWidth = 2;
      context.beginPath();
      trace.times.forEach((time, i) => {
        const y = y1 - Math.min(1, series.value(i) / lane.max) * laneHeight;
        if (i === 0) context.moveTo(x(time), y); else context.lineTo(x(time), y);
      });
      if (lane.fill) { context.lineTo(x(trace.times.at(-1)), y1); context.lineTo(x(trace.times[0]), y1); context.globalAlpha = 0.6; context.fill(); context.globalAlpha = 1; } else context.stroke();
    }
  });
  const bottom = top + lanes.length * (laneHeight + laneGap) - laneGap;
  // Each camera finding shades its span red on its lane.
  context.fillStyle = "rgba(255,70,70,0.28)";
  for (const finding of findings) {
    const lane = FINDING_LANE[finding.rule];
    if (lane == null) continue;
    const [a, b] = [Math.max(start, finding.at), Math.min(end, finding.until ?? finding.at + 0.1)];
    if (b < a) continue;
    context.fillRect(x(a) - 1, top + lane * (laneHeight + laneGap), Math.max(3, x(b) - x(a) + 2), laneHeight);
  }
  // Beats as short ticks under the lanes; cues and findings as lines across them; cuts bold.
  for (const mark of marks) {
    if (mark.time < start || mark.time > end) continue;
    const at = x(mark.time);
    if (mark.kind === "beat") { context.fillStyle = INK.beat; context.fillRect(at, bottom + 2, 1, 6); continue; }
    context.strokeStyle = mark.kind === "finding" ? INK.finding : INK.cue;
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath(); context.moveTo(at, top); context.lineTo(at, bottom); context.stroke();
    context.setLineDash([]);
  }
  context.strokeStyle = INK.cut;
  context.lineWidth = 2;
  for (const cut of trace.cuts) { context.beginPath(); context.moveTo(x(cut.time), top - 4); context.lineTo(x(cut.time), bottom); context.stroke(); }
  // The time axis: a label about every 100 px.
  const span = end - start;
  const tick = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20].find((value) => (span / value) * 100 <= width) ?? 30;
  context.fillStyle = INK.text;
  context.font = "13px kino-label, sans-serif";
  for (let time = Math.ceil(start / tick) * tick; time <= end + 1e-6; time += tick) {
    context.fillRect(x(time), bottom + 10, 1, 5);
    context.fillText(`${Number(time.toFixed(2))}s`, x(time) + 3, bottom + 26);
  }
  context.fillText("white: cover, cuts · teal: plate · orange: mover · red: camera findings · yellow: edge, findings · blue: cues · grey ticks: beats", left + 4, 20);
  return canvas.toBuffer("image/png");
}
