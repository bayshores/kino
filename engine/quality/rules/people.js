// The people in the footage, found on this computer (backend/footage/people.mjs, Apple Vision):
// ctx.people is {src: {samples: [{t, faces, people: [{box, head, top, headBox, hands}]}]}} with
// boxes [x, y, w, h] in fractions of the file's frame, or {src: {unavailable: "why"}}.
//
// head_cut_off: a person's head out of the picture inside the footage (how it was filmed, or
// how kino crops it). overlay_covers_subject (consistency.js) also uses peopleSubjects as the
// subject of a clip nobody marked.
import { cropOnSource } from "../../sourceView.js";
import { mediaFrameState } from "../../playback.js";
import { sec } from "../analysis.js";
import { coveredAt } from "../techniques.js";

// A person counts when their box is this tall a share of the picture shown (a passer-by far away does not).
const BIG_PERSON = 0.4;
// The box's top this close to the top of the picture shown (a share of its height) touches it.
const TOP_TOUCH = 0.02;
// The highest head joint (an eye, an ear) this close to the top: the top of the head is out.
const HEAD_MARGIN = 0.04;
// How long a head may be out while the layer shows, in seconds.
const CUT_SECONDS = 1;
// A sample this far (seconds) from a moment still describes it.
const SAMPLE_REACH = 0.6;
const SHOWN = 0.3;
// Footage this blurred (px) is a backdrop: nobody reads a head or a face in it.
const SOFT_BLUR = 16;
/** True when the clip is blurred into a backdrop at sample `index`. */
export const blurred = (item, index) => item.blur >= SOFT_BLUR || item.samples.blur?.[index] >= SOFT_BLUR;

/** The measured sample nearest file time `at`, or null. */
export function peopleNear(found, at) {
  let best = null;
  for (const sample of found?.samples ?? []) if (Math.abs(sample.t - at) <= SAMPLE_REACH && (!best || Math.abs(sample.t - at) < Math.abs(best.t - at))) best = sample;
  return best;
}

const toPercent = ([x, y, w, h]) => [x * 100, y * 100, w * 100, h * 100];

/**
 * The subjects a detector found at file time `at`, as [x, y, w, h] boxes in % of the file's
 * frame: every face Vision found (a close-up whose body it missed too), each person's head with
 * no face found in it (the box around the head joints, narrowed to a head's shape) and the hands
 * they hold up (a phone). `aspect` is the file's width over its height.
 */
export function peopleSubjects(found, at, aspect = 16 / 9) {
  const sample = peopleNear(found, at);
  if (!sample) return [];
  const faces = sample.faces ?? [];
  const boxes = [...faces];
  for (const person of sample.people ?? []) {
    const [, py, , ph] = person.box;
    if (person.headBox) {
      const [hx, hy, hw, hh] = person.headBox;
      const face = faces.find(([fx, fy, fw, fh]) => fx + fw / 2 >= hx && fx + fw / 2 <= hx + hw && fy + fh / 2 >= hy && fy + fh / 2 <= hy + hh);
      if (!face) {
        const width = Math.min(hw, hh / aspect);
        boxes.push([hx + (hw - width) / 2, hy, width, hh]);
      }
    }
    // A hand raised above the person's middle holds something up to see (a phone).
    for (const [wx, wy] of person.hands ?? []) {
      if (wy > py + ph / 2) continue;
      const r = 0.06 * ph;
      boxes.push([wx - r / aspect, wy - r, (2 * r) / aspect, 2 * r]);
    }
  }
  return boxes.map((box) => {
    const [x, y, w, h] = toPercent(box);
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    return [x0, y0, Math.min(100, x + w) - x0, Math.min(100, y + h) - y0];
  }).filter(([, , w, h]) => w > 0 && h > 0);
}

/** A person in `sample` whose head is out of the picture shown (`bounds` [x0, y0, x1, y1] in %), or null. */
function headless(sample, bounds) {
  const [x0, y0, x1, y1] = bounds;
  const shownHeight = y1 - y0;
  for (const person of sample.people ?? []) {
    const [x, y, w, h] = toPercent(person.box);
    const across = Math.max(0, Math.min(x + w, x1) - Math.max(x, x0));
    if (across < 0.5 * w || Math.min(y + h, y1) - Math.max(y, y0) < BIG_PERSON * shownHeight) continue;
    if (y > y0 + TOP_TOUCH * shownHeight) continue;
    // The pose found no head, or its highest joint is at the top edge.
    const top = person.top != null ? person.top * 100 : null;
    if (!person.head || top == null || top < y0 + HEAD_MARGIN * shownHeight) return { box: person.box, head: person.head ?? 0 };
  }
  return null;
}

/** head_cut_off: a person's head is out of the picture inside a clip for a second or more. */
export function headCutOff(model, ctx) {
  const scene = ctx.scene;
  if (!scene || !ctx.people) return [];
  const findings = [];
  const step = Math.max(1, Math.round(model.fps / 10));
  for (const item of model.items) {
    if (item.kind !== "video" || item.source?.componentPath) continue;
    const layer = scene.layers.find((entry) => entry.id === item.source?.layerId);
    const found = layer && ctx.people[layer.src];
    if (!found?.samples?.length) continue;
    const size = ctx.mediaSizes?.[layer.src] ?? null;
    let run = null, worst = null;
    const close = () => {
      if (run && run.to - run.from >= CUT_SECONDS - 1e-6 && (!worst || run.to - run.from > worst.to - worst.from)) worst = run;
      run = null;
    };
    for (let index = 0; index < model.times.length; index += step) {
      const time = model.times[index];
      if (item.samples.opacity[index] < SHOWN || blurred(item, index) || coveredAt(model, item, index)) { close(); continue; }
      const sourceTime = mediaFrameState(layer, time).sourceTime;
      const sample = peopleNear(found, sourceTime);
      const crop = sample && cropOnSource(scene, layer, time, size);
      const cut = crop && headless(sample, crop.bounds);
      if (!cut) { close(); continue; }
      run ??= { from: time, to: time, crop, sourceTime, cut };
      run.to = time + step / model.fps;
    }
    close();
    if (!worst) continue;
    const kinoCrop = worst.crop.bounds[1] > 1;
    findings.push({
      rule: "head_cut_off", severity: "warn", itemId: item.id, at: sec(worst.from), until: sec(worst.to),
      message: `A person's head is out of the picture in ${ctx.name(item)} from ${sec(worst.from)}s to ${sec(worst.to)}s (file ${sec(worst.sourceTime)}s): ${kinoCrop ? "the crop cuts it off" : "the clip was filmed that way"}.`,
      measured: `a person ${Math.round(worst.cut.box[3] * 100)}% of the file tall touching the top of the picture, ${worst.cut.head ? "the highest head joint at the edge" : "no head found"}, for ${sec(worst.to - worst.from)}s`,
      required: `a person's head in the picture (at most ${CUT_SECONDS}s out)`,
      fix: { kind: "hint", text: kinoCrop
        ? `Move ${ctx.name(item)} down or scale it less so the top of the file shows (look {mode:"source", layer:${ctx.name(item)}, t:${sec(worst.from)}} shows the crop), or play another part of the clip (mediaOffset); waive_check {code:"head_cut_off", target, reason} if it is meant to.`
        : `Play another part of the clip where the head shows (mediaOffset), shorten ${ctx.name(item)}, or cover it with another shot; waive_check {code:"head_cut_off", target, reason} if it is meant to (a walking shot of feet, a body detail).` },
    });
  }
  return findings;
}
