// screen-recording: the edit a screen recording kino made gets from its own pointer and click
// data (layer.recording, engine/recording.js), all as ordinary layers and animations:
//   - zooms: the clip pushes in (2x by default) from just before each click (or mark) and
//     follows the pointer while zoomed, then pulls back; one spring (stiffness 125, damping 12,
//     mass 1.5, no overshoot) turned into a bezier, so every move is the same feel;
//   - the pointer: kino's own vector pointer (arrow, hand, I-beam) rides the spring-smoothed
//     path (a pin), lands on every click on time, grows with the zoom, squishes while pressed
//     and hides while the person or agent types;
//   - clicks: a soft ring opens where each click lands;
//   - typing: runs of typing can play faster (speed), the clip's other moments stay real time.
// The recording plays without its own pointer (kino-recorder leaves it out), so this pointer is
// the only one. Nothing here is guessed: every time and place comes from the recorded events.
import { createLayer } from "../../model.js";
import { evaluateLayer } from "../../animation.js";
import { effectiveMediaDuration, mediaSceneTime } from "../../playback.js";
import { MAX_PIN_SAMPLES } from "../../pin.js";
import { autoZooms, cursorHidden, inPicture, smoothCursor, springEase, springSeconds, typingRuns } from "../../recording.js";
import { cursorPath, SHAPES, UNITS } from "./cursor.js";
import { CURVES, hide, motion, round, show } from "./kit.js";

const SPRING = Object.freeze({ stiffness: 125, damping: 12, mass: 1.5 });
// The standard macOS pointer is about this many points tall.
const POINTER_POINTS = 23;
// Recorded pointer shapes kino draws, and what the others draw as.
const SHAPE_FOR = { arrow: "arrow", pointer: "hand", text: "text", grab: "grab", grabbing: "grab", crosshair: "arrow", resize: "arrow", notAllowed: "arrow", other: "arrow" };
const PRESSED = 0.9;
const RING = { start: 0.35, seconds: 0.45, opacity: 0.55 };
const MAX_SWITCHES = 400;

// Where the recording's picture sits inside the layer's box: drawn at its own shape, centered.
function pictureRect(layer, frame) {
  const scale = Math.min(layer.width / frame[0], layer.height / frame[1]);
  return { x: (layer.width - frame[0] * scale) / 2, y: (layer.height - frame[1] * scale) / 2, scale };
}

export const screenRecording = {
  name: "screen-recording",
  about: "a screen recording kino made gets its edit from its own pointer and click data: zooms that follow each click and the pointer, kino's smooth pointer landing on every click, click rings, optional faster typing",
  fits: "a screen recording from project {action:\"record\"}: make it read like a designed product demo",
  tags: ["screen-zoom", "cursor"],
  length: 2,
  untilEnd: true,
  fields: {
    layer: { kind: "layer", required: true, about: "the video layer playing a recording from project {action:\"record\"} (it keeps the recording's pointer and clicks)" },
    zoom: { kind: "number", low: 1, high: 4, about: "how far each click zooms in (default 2; 1 = no zooms)" },
    pointer: { kind: "choice", values: [true, false], about: "draw kino's pointer on the smoothed path (default true)" },
    size: { kind: "number", low: 0.5, high: 4, about: "the pointer's size as a share of the real one (default 1.5)" },
    clicks: { kind: "choice", values: ["ring", "none"], about: "what a click shows (default ring)" },
    typing: { kind: "number", low: 1, high: 8, about: "play typing runs of 1.5 s or more this many times faster (default 1, real time)" },
    hold: { kind: "number", low: 0.8, high: 10, about: "seconds a zoom stays after its click (default 2.5)" },
  },
  example: { layer: "clip", zoom: 2 },
  setup: "a video layer whose src came from project {action:\"record\", options:{step:\"stop\"}} (kino adds its recording data when the layer is added)",
  build(ctx, input) {
    const clip = ctx.layer(input.layer);
    const rec = clip.recording;
    if (clip.type !== "video" || !rec) throw new Error(`screen-recording: ${input.layer} has no recording data; add the src a record stop gave as a video layer (kino keeps the pointer and clicks with it).`);
    if (["rotation", "rotateX", "rotateY", "skewX"].some((key) => Math.abs(clip[key] ?? 0) > 0.5)) throw new Error(`screen-recording: ${input.layer} is turned; the pointer could not land on the recorded places.`);
    const level = input.zoom ?? 2;
    const picture = pictureRect(clip, rec.frame);
    const notes = [];
    const ease = springEase(SPRING.stiffness, SPRING.damping, SPRING.mass);
    const springTime = springSeconds(SPRING.stiffness, SPRING.damping, SPRING.mass);

    // ---- typing faster: speed ramps on the clip (scene times move, so this comes first) ----
    const speedUps = [];
    let timed = { ...clip, animations: [...(clip.animations ?? [])] };
    if ((input.typing ?? 1) > 1) {
      const ramp = 0.2;
      const runs = typingRuns(rec);
      runs.forEach((run, index) => {
        const begins = mediaSceneTime(timed, run.start);
        if (begins === null) return;
        const up = motion({ name: "Typing faster", start: begins, duration: ramp, easing: CURVES.fade, from: { speed: 1 }, to: { speed: input.typing } });
        timed = { ...timed, animations: [...timed.animations, { id: `typing-up${index}`, ...up }] };
        const ends = mediaSceneTime(timed, run.end);
        if (ends === null || ends - ramp <= begins + ramp) { timed.animations.pop(); return; }
        const down = motion({ name: "Typing real time", start: ends - ramp, duration: ramp, easing: CURVES.fade, from: { speed: input.typing }, to: { speed: 1 } });
        timed = { ...timed, animations: [...timed.animations, { id: `typing-down${index}`, ...down }] };
        ctx.animate(clip.id, `typing-up${index + 1}`, up, "clip");
        ctx.animate(clip.id, `typing-down${index + 1}`, down, "clip");
        speedUps.push({ from: round(run.start), to: round(run.end) });
      });
      if (speedUps.length) {
        // The clip now ends sooner on the scene: its Play is shortened to match.
        const end = mediaSceneTime(timed, (clip.mediaOffset ?? 0) + rec.duration - 0.02);
        if (end !== null) ctx.set(clip.id, { mediaDuration: round(end - (clip.mediaStart ?? 0) + 0.02) });
        notes.push(`typing plays ${input.typing}x faster in ${speedUps.length} run${speedUps.length === 1 ? "" : "s"}`);
      }
    }
    const sceneAt = (t) => mediaSceneTime(timed, (clip.mediaOffset ?? 0) + t);

    // ---- zooms: the clip's scale and place, about its own center ----
    const box = { width: clip.width, height: clip.height };
    const center = { x: clip.width / 2, y: clip.height / 2 };
    // The shift that puts recording point (x, y) at the box's center at scale s, kept so the
    // zoomed picture still covers the box.
    const shiftFor = (x, y, s) => {
      const local = { x: picture.x + x * picture.scale, y: picture.y + y * picture.scale };
      const limit = { x: ((s - 1) * box.width) / 2, y: ((s - 1) * box.height) / 2 };
      return {
        x: Math.max(-limit.x, Math.min(limit.x, -(local.x - center.x) * s)),
        y: Math.max(-limit.y, Math.min(limit.y, -(local.y - center.y) * s)),
      };
    };
    const zooms = level > 1 ? autoZooms(rec, { level, hold: input.hold ?? 2.5 }) : [];
    const base = { x: clip.x, y: clip.y, scaleX: clip.scaleX ?? 1, scaleY: clip.scaleY ?? 1 };
    let placed = 0;
    let lastEnd = -Infinity;
    zooms.forEach((zoom, index) => {
      const start = sceneAt(zoom.start);
      const end = sceneAt(zoom.end);
      if (start === null || end === null || end - start < 2 * springTime || start < lastEnd) return;
      lastEnd = end;
      const n = index + 1;
      const s = level;
      const at = zoom.focus.map((focus) => ({ time: sceneAt(focus.t) ?? start, shift: shiftFor(focus.x, focus.y, s) }));
      const first = at[0].shift;
      const scaleTo = { scaleX: round(base.scaleX * s, 4), scaleY: round(base.scaleY * s, 4) };
      ctx.animate(clip.id, `zoom${n}-in`, motion({ name: "Zoom in", start, duration: springTime, easing: ease, from: { scaleX: base.scaleX, scaleY: base.scaleY }, to: scaleTo }), "clip");
      ctx.animate(clip.id, `zoom${n}-in-x`, motion({ name: "Zoom in", start, duration: springTime, easing: ease, from: { x: base.x }, to: { x: round(base.x + first.x, 1) } }), "clip");
      ctx.animate(clip.id, `zoom${n}-in-y`, motion({ name: "Zoom in", start, duration: springTime, easing: ease, from: { y: base.y }, to: { y: round(base.y + first.y, 1) } }), "clip");
      // Following the pointer while zoomed: each new center, one spring each, never overlapping.
      let from = first;
      let free = start + springTime;
      const outAt = end - springTime;
      at.slice(1).forEach((entry, step) => {
        const begins = Math.max(entry.time, free);
        const length = Math.min(springTime, outAt - begins);
        if (length < 0.15 || (Math.abs(entry.shift.x - from.x) < 2 && Math.abs(entry.shift.y - from.y) < 2)) return;
        ctx.animate(clip.id, `zoom${n}-follow${step + 1}-x`, motion({ name: "Follow", start: begins, duration: length, easing: ease, from: { x: round(base.x + from.x, 1) }, to: { x: round(base.x + entry.shift.x, 1) } }), "clip");
        ctx.animate(clip.id, `zoom${n}-follow${step + 1}-y`, motion({ name: "Follow", start: begins, duration: length, easing: ease, from: { y: round(base.y + from.y, 1) }, to: { y: round(base.y + entry.shift.y, 1) } }), "clip");
        from = entry.shift;
        free = begins + length;
      });
      ctx.animate(clip.id, `zoom${n}-out`, motion({ name: "Zoom out", start: outAt, duration: springTime, easing: ease, from: scaleTo, to: { scaleX: base.scaleX, scaleY: base.scaleY } }), "clip");
      ctx.animate(clip.id, `zoom${n}-out-x`, motion({ name: "Zoom out", start: outAt, duration: springTime, easing: ease, from: { x: round(base.x + from.x, 1) }, to: { x: base.x } }), "clip");
      ctx.animate(clip.id, `zoom${n}-out-y`, motion({ name: "Zoom out", start: outAt, duration: springTime, easing: ease, from: { y: round(base.y + from.y, 1) }, to: { y: base.y } }), "clip");
      placed += 1;
    });
    if (placed) notes.push(`${placed} zoom${placed === 1 ? "" : "s"} at ${level}x`);

    // Where recording point (x, y) is drawn on the scene at scene time `time`, with the zooms.
    const zoomed = { ...timed, animations: [...timed.animations, ...ctx.ownAnimations(clip.id)] };
    const onScene = (x, y, time) => {
      const state = evaluateLayer(zoomed, time);
      const sx = state.scaleX ?? 1, sy = state.scaleY ?? 1;
      const cx = state.x + state.width / 2, cy = state.y + state.height / 2;
      return { x: cx + (picture.x + x * picture.scale - state.width / 2) * sx, y: cy + (picture.y + y * picture.scale - state.height / 2) * sy, s: sx / base.scaleX };
    };

    const cues = [];
    const clipStart = clip.mediaStart ?? 0;
    const playing = effectiveMediaDuration(timed);
    const clipEnd = clipStart + (Number.isFinite(playing) && playing > 0 ? playing : rec.duration);

    // ---- the pointer ----
    if (input.pointer !== false && rec.moves.length) {
      const path = smoothCursor(rec, SPRING);
      const samples = [];
      for (const [t, x, y] of path) {
        const time = sceneAt(t);
        if (time === null) continue;
        const at = onScene(x, y, time);
        samples.push([round(time, 3), round(at.x, 1), round(at.y, 1), round(at.s, 3), round(at.s, 3), 1]);
      }
      // While the clip zooms or follows, the pointer moves on the scene even when it is still in
      // the recording: 8 samples across each of those moves keep it on its spot.
      const recordingAt = recordingClock(rec.duration, sceneAt);
      for (const animation of ctx.ownAnimations(clip.id)) {
        if (!/zoom\d+-(in|out|follow\d+)-x$/.test(animation.id) && !/zoom\d+-(in|out)$/.test(animation.id)) continue;
        for (let step = 0; step <= 8; step += 1) {
          const time = animation.start + (animation.duration * step) / 8;
          const t = recordingAt(time);
          if (t === null) continue;
          const [x, y] = pathAt(path, t);
          const at = onScene(x, y, time);
          samples.push([round(time, 3), round(at.x, 1), round(at.y, 1), round(at.s, 3), round(at.s, 3), 1]);
        }
      }
      samples.sort((a, b) => a[0] - b[0]);
      let unique = samples.filter((sample, index) => index === 0 || sample[0] > samples[index - 1][0]);
      if (unique.length > MAX_PIN_SAMPLES) unique = Array.from({ length: MAX_PIN_SAMPLES }, (_, index) => unique[Math.round((index * (unique.length - 1)) / (MAX_PIN_SAMPLES - 1))]);
      if (unique.length) {
        const height = POINTER_POINTS * picture.scale * base.scaleY * (input.size ?? 1.5);
        const k = height / UNITS;
        // The group's center is the hotspot, so scaling about the center never moves the tip.
        const span = round(2 * UNITS * k, 1);
        const group = ctx.add("pointer", createLayer("group", { x: round(unique[0][1] - span / 2, 1), y: round(unique[0][2] - span / 2, 1), width: span, height: span, role: "ui", allowOverlap: true,
          pin: { track: `${clip.id}-pointer`, offset: [0, 0], scale: true, base: [1, 1], path: unique } }), "top");
        // The shapes this recording shows, each switched on while the recorded pointer had it.
        const shapeAt = shapeTimeline(rec);
        const used = [...new Set(shapeAt.map((entry) => entry.shape))];
        const parts = {};
        for (const name of used) {
          const shape = SHAPES[name];
          parts[name] = ctx.add(`pointer-${name}`, createLayer("path", {
            x: round(span / 2 - shape.hot[0] * k, 1), y: round(span / 2 - shape.hot[1] * k, 1), width: round(UNITS * k, 1), height: round(UNITS * k, 1),
            path: cursorPath(name, height), pathBounds: { x: 0, y: 0, width: round(UNITS * k, 1), height: round(UNITS * k, 1) },
            fill: shape.fill, stroke: shape.stroke, strokeWidth: round(Math.max(1, 1.25 * k), 2), role: "ui", allowOverlap: true,
            shadow: { color: "#00000059", x: 0, y: round(height * 0.05, 1), blur: round(height * 0.16, 1) },
          }), "top", group);
        }
        let switches = 0;
        let showing = shapeAt[0]?.shape ?? "arrow";
        for (const name of used) if (name !== showing) ctx.animate(parts[name], "start-hidden", hide(clipStart));
        for (const entry of shapeAt.slice(1)) {
          const time = sceneAt(entry.t);
          if (time === null || entry.shape === showing || switches >= MAX_SWITCHES) continue;
          switches += 1;
          ctx.animate(parts[showing], `off${switches}`, hide(time));
          ctx.animate(parts[entry.shape], `on${switches}`, show(time));
          showing = entry.shape;
        }
        // Pressed: 0.9 while the button is down. Hidden: while typing.
        rec.clicks.forEach(([t], index) => {
          const down = sceneAt(t);
          if (down === null || ctx.reduced) return;
          const upAt = rec.drags.find(([start]) => Math.abs(start - t) < 0.01)?.[1] ?? t + 0.12;
          const up = Math.max(down + 0.08, sceneAt(upAt) ?? down + 0.12);
          ctx.animate(group, `press${index + 1}`, motion({ name: "Press", start: down, duration: 0.07, easing: CURVES.arrive, from: { scaleX: 1, scaleY: 1 }, to: { scaleX: PRESSED, scaleY: PRESSED } }));
          ctx.animate(group, `release${index + 1}`, motion({ name: "Release", start: up, duration: 0.14, easing: CURVES.settle, from: { scaleX: PRESSED, scaleY: PRESSED }, to: { scaleX: 1, scaleY: 1 } }));
        });
        cursorHidden(rec).forEach((range, index) => {
          const start = sceneAt(range.start), end = sceneAt(range.end);
          // Typing fades the pointer; leaving the picture (a window recording) hides it at once.
          const fade = range.outside ? 0.04 : 0.15;
          if (start === null || end === null || end - start < (range.outside ? 0.1 : 0.4)) return;
          ctx.animate(group, `typing-hide${index + 1}`, motion({ name: range.outside ? "Hide outside" : "Hide for typing", start, duration: fade, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
          // Hidden to the clip's end: it does not come back.
          const showAt = Math.max(start + fade, end - fade);
          if (showAt + fade > Math.min(clipEnd, ctx.sceneDuration) - 0.01) return;
          ctx.animate(group, `typing-show${index + 1}`, motion({ name: range.outside ? "Show inside" : "Show after typing", start: showAt, duration: fade, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
        });
        if (clipStart > 0.01) ctx.animate(group, "before-clip", hide(0)), ctx.animate(group, "with-clip", show(clipStart));
        if (clipEnd < ctx.sceneDuration - 0.01) ctx.animate(group, "after-clip", hide(clipEnd));
        notes.push(`the pointer follows ${unique.length} smoothed samples`);
      }
    }

    // ---- click rings ----
    if (input.clicks !== "none" && rec.clicks.length && !ctx.reduced) {
      const ringSize = round(POINTER_POINTS * picture.scale * base.scaleY * 2.2, 1);
      const path = [];
      const clicks = [];
      for (const [t, x, y] of rec.clicks) {
        const time = sceneAt(t);
        if (time === null || !inPicture(rec, x, y)) continue;
        const at = onScene(x, y, time);
        // The ring waits where the last click was until the next one (no sliding between).
        if (path.length) path.push([round(time - 0.001, 3), path.at(-1)[1], path.at(-1)[2], 1, 1, 1]);
        path.push([round(time, 3), round(at.x, 1), round(at.y, 1), 1, 1, 1]);
        clicks.push({ time, s: at.s });
      }
      if (clicks.length) {
        const ring = ctx.add("click-ring", createLayer("ellipse", { x: round(path[0][1] - ringSize / 2, 1), y: round(path[0][2] - ringSize / 2, 1), width: ringSize, height: ringSize,
          fill: "#FFFFFF00", stroke: "#FFFFFF", strokeWidth: round(Math.max(1.5, ringSize * 0.06), 1), opacity: 0, role: "ui", allowOverlap: true,
          shadow: { color: "#00000040", x: 0, y: 0, blur: round(ringSize * 0.12, 1) },
          pin: { track: `${clip.id}-clicks`, offset: [0, 0], scale: false, path: path.slice(0, MAX_PIN_SAMPLES) } }), "top");
        let last = -Infinity;
        clicks.forEach(({ time, s }, index) => {
          if (time < last + RING.seconds) return;
          last = time;
          const grow = round(s, 3);
          ctx.animate(ring, `open${index + 1}`, motion({ name: "Click ring", start: time, duration: RING.seconds, easing: CURVES.settle, from: { scaleX: RING.start * grow, scaleY: RING.start * grow }, to: { scaleX: grow, scaleY: grow } }));
          ctx.animate(ring, `fade${index + 1}`, motion({ name: "Click ring fade", start: time, duration: RING.seconds, easing: CURVES.fade, from: { opacity: RING.opacity }, to: { opacity: 0 } }));
          cues.push({ name: `${ctx.id}.click${index + 1}`, time: round(time) });
        });
      }
    }

    // Marks become cues (sound, captions and look can use them).
    rec.marks.forEach(([t, label], index) => {
      const time = sceneAt(t);
      if (time !== null) cues.push({ name: `${ctx.id}.mark${index + 1}`, time: round(time) });
      if (time !== null && index < 12) notes.push(`mark "${label}" at ${round(time)} s`);
    });
    for (const text of notes) ctx.note(text);
    return { start: round(clipStart), end: round(Math.min(ctx.sceneDuration, clipEnd)), cues };
  },
};

// The recorded pointer's shape over time: [{t, shape}] with kino's shape names.
function shapeTimeline(rec) {
  const entries = [];
  for (const [t, , , index] of rec.moves) {
    const shape = SHAPE_FOR[rec.shapes[index]] ?? "arrow";
    if (!SHAPES[shape]) continue;
    if (entries.at(-1)?.shape === shape) continue;
    entries.push({ t, shape });
  }
  return entries.length ? entries : [{ t: 0, shape: "arrow" }];
}

function pathAt(path, t) {
  if (t <= path[0][0]) return [path[0][1], path[0][2]];
  for (let index = 1; index < path.length; index += 1) {
    if (path[index][0] >= t) {
      const a = path[index - 1], b = path[index];
      const share = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
      return [a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share];
    }
  }
  return [path.at(-1)[1], path.at(-1)[2]];
}

// The recording second shown at a scene time: a table of the clip's clock every 20 ms, read
// straight between entries (scene time only grows with recording time). null outside the clip.
function recordingClock(duration, sceneAt) {
  const table = [];
  for (let t = 0; t <= duration + 1e-9; t += 0.02) {
    const at = sceneAt(t);
    if (at !== null && (!table.length || at > table.at(-1)[0])) table.push([at, t]);
  }
  return (time) => {
    if (!table.length || time < table[0][0] || time > table.at(-1)[0]) return null;
    let low = 0, high = table.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (table[middle][0] <= time) low = middle; else high = middle;
    }
    const a = table[low], b = table[high];
    return b[0] > a[0] ? a[1] + ((time - a[0]) / (b[0] - a[0])) * (b[1] - a[1]) : a[1];
  };
}
