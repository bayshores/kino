// ui-plane: real UI on a plane tilted in perspective, floating in a dark void, the look of a
// calm, premium launch film. The plane lies back 25 to 35
// degrees with its far edges falling off into the void, a vignette closes the frame, and the
// camera drifts slowly over it. `flat` swings the plane flat to the frame for the hero moment
// (about 0.45 s, fast then soft). 2.5D only: the plane is drawn with src/tilt.js.
import { createLayer } from "../../model.js";
import { CURVES, hide, motion, round, show } from "./kit.js";
import { evaluateLayer } from "../../animation.js";
import { tiltProjector } from "../../tilt.js";
import { isVisibilityOperation, visibleByOperations } from "../../visibilityOps.js";

// Each angle: the plane's turn (degrees), its eye distance at 1080p (px) and how big it is (a
// share of the frame it would cover flat). The film plane is bigger than the frame, so it runs
// off two sides and its far corner fades out in the void; soft is a gentler lean.
export const PLANE_ANGLES = Object.freeze({
  linear: Object.freeze({ rotateX: 32, rotateY: 18, rotation: -8, perspective: 1500, size: 1.5 }),
  soft: Object.freeze({ rotateX: 18, rotateY: 10, rotation: -3, perspective: 2200, size: 1.15 }),
  flat: Object.freeze({ rotateX: 0, rotateY: 0, rotation: 0, perspective: 2600, size: 0.86 }),
});
// The drift: a share of the frame diagonal a second (a calm film moves 2 to 4% a second), never more
// than DRIFT_MOST of the diagonal in all, a push of 1.5% a second and the plane easing 2 degrees
// flatter over the hold, so the light on it changes too.
const DRIFT_SPEED = 0.02;
const DRIFT_MOST = 0.1;
const PUSH = 0.015;
const EASE_FLATTER = 2;
// The swing flat and what it ends at: the plane fills this share of the frame, then pushes 2% a second.
const SWING = 0.45;
const FLAT_SIZE = 0.9;
const FLAT_PUSH = 0.02;
// The swing starts from rest (the drift eases out, so no speed jump), is fastest a third of the
// way and lands soft; a blur rides its fast part, none in reduced motion.
const SWING_CURVE = Object.freeze([0.5, 0, 0.1, 1]);
const SWING_BLUR = 8;
const REST = 0.04;
const FADE = 0.3;
const SHARP = 1.3;
// The uploaded file behind a picture or clip layer (its pixel size), or null when it is not known.
function fileOf(ctx, layer) {
  if (layer.type === "image") {
    try { return ctx.picture(layer.src); } catch { /* not an uploaded picture by that name */ }
  }
  const size = ctx.fileSize(layer.src);
  return size?.width > 0 && size?.height > 0 ? size : null;
}
// The pixels behind the plane, as one file the size of its box: a picture or clip is its own
// file; a group (split_image pieces) takes its most magnified picture or clip inside, so the
// plane is never drawn so big that a piece's pixels look soft. Returns {width, height, why} or null.
function sourceOf(ctx, layer, box) {
  let worst = null;
  for (const part of ctx.mediaOf(layer.id)) {
    const file = fileOf(ctx, part);
    if (!file) continue;
    // The part's size in the plane's own box: its own scale and that of every group between them.
    let [width, height] = [box.width, box.height];
    if (part.id !== layer.id) {
      const state = ctx.partStateAt(part.id, ctx.start);
      [width, height] = [state.width * Math.abs(state.scaleX ?? 1), state.height * Math.abs(state.scaleY ?? 1)];
      for (const group of ctx.parents(part.id).filter((parent) => parent.id !== layer.id)) {
        const scale = ctx.partStateAt(group.id, ctx.start);
        [width, height] = [width * Math.abs(scale.scaleX ?? 1), height * Math.abs(scale.scaleY ?? 1)];
      }
    }
    const inside = Math.min(width / file.width, height / file.height);
    if (inside > 0 && (!worst || inside > worst.inside)) worst = { inside, file, part };
  }
  if (!worst) return null;
  const why = worst.part.id === layer.id ? `${layer.id}'s file is ${worst.file.width}x${worst.file.height} px`
    : `${worst.part.id} in ${layer.id} shows its ${worst.file.width}x${worst.file.height} px file at ${round(worst.inside, 2)}x`;
  return { width: box.width / worst.inside, height: box.height / worst.inside, why };
}
// How many screen pixels per file pixel `pose` draws the plane at: the bounds of its turned,
// scaled and tilted box over the file's size, as soft_upscale measures it.
function magnified(box, file, pose) {
  const turn = (pose.rotation * Math.PI) / 180, cos = Math.cos(turn), sin = Math.sin(turn);
  const project = tiltProjector(pose);
  const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const x = (u * box.width * pose.scaleX) / 2, y = (v * box.height * pose.scaleY) / 2;
    return project(x * cos - y * sin, x * sin + y * cos);
  });
  const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
  return Math.min((Math.max(...xs) - Math.min(...xs)) / file.width, (Math.max(...ys) - Math.min(...ys)) / file.height);
}
// The largest scale, at most `scale`, at which `turn` (angles and perspective) stays at or under
// SHARP times the file's pixels when the scale has grown by `grow` (a push).
function sharpScale(box, file, turn, scale, grow = 1) {
  if (!(file?.width > 0 && file?.height > 0)) return scale;
  let fitted = scale;
  for (let step = 0; step < 6; step += 1) {
    const drawn = magnified(box, file, { ...turn, scaleX: fitted * grow, scaleY: fitted * grow });
    if (drawn <= SHARP) break;
    fitted *= (SHARP / drawn) * 0.998;
  }
  return fitted;
}
// The void is near black, never pure black (pure_frame).
const VOID = "#060708";
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// The plane's place (x, y, scale) when its center sits at `center` scaled by `scale`.
const placed = (box, center, scale) => ({ x: round(center.x - box.width / 2, 1), y: round(center.y - box.height / 2, 1), scaleX: round(scale, 4), scaleY: round(scale, 4) });
const sixDigits = (hex) => (hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}` : hex).toUpperCase();
const alpha = (amount) => Math.round(amount * 255).toString(16).padStart(2, "0").toUpperCase();

/**
 * The direction (degrees, in the plane's own coordinates, 0 = right, 90 = down) in which the
 * tilted plane goes away from the eye: positive rotateX tips the top away, positive rotateY the
 * right side, and the plane's own rotation turns its coordinates first.
 */
export function farAngle({ rotateX, rotateY, rotation }) {
  const toRadians = Math.PI / 180;
  const screen = Math.atan2(-Math.sin(rotateX * toRadians), Math.sin(rotateY * toRadians)) / toRadians;
  return round(((screen - rotation) % 360 + 360) % 360, 2);
}

export const uiPlane = {
  name: "ui-plane",
  about: "real UI (a screenshot, recording or split_image group) lies on a plane tilted 25 to 35 degrees in perspective, in a dark void: its far edges fall off into the dark, a vignette closes the frame and the camera drifts slowly over it; flat swings it flat to the frame for the hero moment",
  fits: "showing a product's real screens in a calm, premium launch film: a document, a dashboard, a list",
  tags: ["orbit-3d", "drift"],
  length: 4,
  shortest: 1.5,
  // The look lasts the shot: to the scene's end unless dur says otherwise.
  untilEnd: true,
  fields: {
    layer: { kind: "layer", required: true, about: "the UI: a picture, a video or a group (split_image pieces)" },
    angle: { kind: "choice", values: ["linear", "soft", "flat"], about: "linear (default): 32 degrees back, turned away to the right, bigger than the frame; soft: 18 degrees; flat: no tilt, only the void, vignette and drift" },
    void: { kind: "text", max: 7, about: "the void's color, a dark #hex (default #060708, near black)" },
    flat: { kind: "number", low: 0, high: 600, about: "scene seconds when the plane swings flat to 90% of the frame, less when its pixels would pass 1.3x (0.45 s, fast then soft) and pushes in slowly" },
  },
  example: { layer: "shot-b", at: 0, flat: 2.6 },
  setup: "shot-b, a picture of an app window or page",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const color = input.void ?? VOID;
    if (!HEX.test(color)) throw new Error(`ui-plane void must be a #hex color such as "#000" or "#0B0C0E", not "${color}".`);
    const dark = sixDigits(color);
    const angle = PLANE_ANGLES[input.angle ?? "linear"];
    const swingAt = input.flat;
    if (swingAt !== undefined && (swingAt < ctx.start + 0.5 || swingAt > ctx.end - SWING))
      throw new Error(`ui-plane flat must be from ${round(ctx.start + 0.5, 2)} to ${round(ctx.end - SWING, 2)} s (at least 0.5 s after the move starts and ${SWING} s before it ends).`);
    const state = ctx.stateAt(layer.id, ctx.start);
    const box = { width: state.width, height: state.height };
    const { frame } = ctx;
    const fit = (share) => Math.min((frame.width * share) / box.width, (frame.height * share) / box.height);
    const middle = { x: frame.width / 2, y: frame.height / 2 };
    const perspective = Math.round(angle.perspective * ctx.scale);
    // The drift: the plane slides toward its near corner (the camera moves up the page) and
    // pushes in, at DRIFT_SPEED of the diagonal a second, never past DRIFT_MOST in all.
    // Before a swing the drift comes to rest a frame early: the swing then starts from still, a
    // new move (speed_jump would read the soft start of a big swing as a jump from the drift).
    const holdEnd = swingAt === undefined ? ctx.end : swingAt - REST;
    const hold = holdEnd - ctx.start;
    // A picture or clip is never drawn past SHARP times its file's pixels (soft_upscale), at the
    // drift's start or at its end (pushed in, 2 degrees flatter), whichever is bigger on screen.
    // A group (split_image pieces) is held to its pieces' pixels the same way.
    const file = sourceOf(ctx, layer, box);
    const wanted = fit(angle.size);
    const turnOf = (turn) => ({ rotateX: turn.rotateX, rotateY: turn.rotateY, rotation: turn.rotation, perspective });
    const flatter = { ...turnOf(angle), ...(angle.rotateX ? { rotateX: angle.rotateX - EASE_FLATTER } : {}) };
    const size = Math.min(sharpScale(box, file, turnOf(angle), wanted), sharpScale(box, file, flatter, wanted, 1 + PUSH * hold));
    if (size < wanted - 1e-4) ctx.note(`the plane is ${round(size, 2)}x, not ${round(wanted, 2)}x: ${file.why} and would look soft bigger`);
    // Reduced motion: the same slow drift, and a cut flat instead of the swing.
    const pose = (center, scale, turn) => ({ ...placed(box, center, scale), ...turnOf(turn) });
    const first = pose(middle, size, angle);
    const diagonal = Math.hypot(frame.width, frame.height);
    const travel = Math.min(DRIFT_SPEED * hold, DRIFT_MOST) * diagonal;
    const slide = [-0.6, -0.8];
    const last = pose({ x: middle.x + slide[0] * travel, y: middle.y + slide[1] * travel }, first.scaleX * (1 + PUSH * hold), flatter);
    const drift = (target, role) => ctx.animate(target, "drift", motion({ name: "Plane drift", start: ctx.start, duration: hold, easing: CURVES.drift, from: first, to: last }), role);
    // The void: the frame's dark, under the plane, while the move plays.
    const voidLayer = ctx.add("void", createLayer("rectangle", { name: "Void", x: 0, y: 0, width: frame.width, height: frame.height, fill: dark, role: "decor", allowOverlap: true }), { below: layer.id });
    // The light falls off toward the plane's far edges: a gradient on a copy of the plane's
    // box, moved and tilted with it, from clear on the near half to the void's dark at the far edge.
    const falloff = angle.rotateX || angle.rotateY ? ctx.add("falloff", createLayer("rectangle", {
      name: "Falloff", x: layer.x, y: layer.y, width: layer.width, height: layer.height, role: "decor", allowOverlap: true,
      fill: { type: "linear", angle: farAngle(angle), stops: [{ offset: 0, color: `${dark}00` }, { offset: 0.42, color: `${dark}00` }, { offset: 1, color: `${dark}${alpha(0.92)}` }] },
    }), { above: layer.id }) : null;
    // The vignette: an ellipse the frame's shape, clear in the middle, dark at the corners.
    const side = Math.round(frame.width * 1.2);
    const vignette = ctx.add("vignette", createLayer("rectangle", {
      name: "Vignette", x: round((frame.width - side) / 2, 1), y: round((frame.height - side) / 2, 1), width: side, height: side,
      scaleY: round(frame.height / frame.width, 4), role: "decor", allowOverlap: true,
      fill: { type: "radial", angle: 0, stops: [{ offset: 0, color: `${dark}00` }, { offset: 0.5, color: `${dark}00` }, { offset: 0.85, color: `${dark}${alpha(0.55)}` }, { offset: 1, color: `${dark}${alpha(0.85)}` }] },
    }), { above: falloff ? falloff.id : layer.id });
    const parts = [[layer.id, "plane"], ...(falloff ? [[falloff, null]] : [])];
    for (const [target, role] of parts) drift(target, role);
    // The swing flat: tilt and turn go to 0 as the plane grows to fill the frame, the falloff
    // fades with it (a flat plane has no far edge), then a slow push to the end.
    if (swingAt !== undefined) {
      const swing = ctx.reduced ? 0.001 : SWING;
      const after = ctx.end - swingAt - swing;
      const pushing = !ctx.reduced && after >= 0.5;
      // Flat and pushed in to the end, still sharp.
      const flatTurn = turnOf(PLANE_ANGLES.flat);
      const flatSize = sharpScale(box, file, flatTurn, fit(FLAT_SIZE), pushing ? 1 + FLAT_PUSH * after : 1);
      const share = Math.round((flatSize / fit(1)) * 100);
      ctx.note(`flat at ${swingAt} s: the plane lands at ${round(flatSize, 2)}x, ${share}% of the frame${share < FLAT_SIZE * 100 ? ` (not ${FLAT_SIZE * 100}%: ${file.why} and would pass ${SHARP}x)` : ""}`);
      const flat = pose(middle, flatSize, PLANE_ANGLES.flat);
      for (const [target, role] of parts) {
        ctx.animate(target, "flat", motion({ name: "Swing flat", start: swingAt, duration: swing, easing: SWING_CURVE, from: last, to: flat }), role);
        if (pushing) {
          const pushed = round(flat.scaleX * (1 + FLAT_PUSH * after), 4);
          ctx.animate(target, "push", motion({ name: "Slow push", start: swingAt + swing, duration: after, easing: CURVES.drift, from: { scaleX: flat.scaleX, scaleY: flat.scaleY }, to: { scaleX: pushed, scaleY: pushed } }), role);
        }
      }
      if (falloff) ctx.animate(falloff, "fade", motion({ name: "Light even", start: swingAt, duration: Math.max(FADE, swing), easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
      if (!ctx.reduced) {
        const rest = layer.blur ?? 0;
        const smear = rest + Math.round(SWING_BLUR * ctx.scale);
        ctx.animate(layer.id, "smear", motion({ name: "Swing blur", start: swingAt, duration: swing * 0.3, easing: CURVES.fade, from: { blur: rest }, to: { blur: smear } }), "plane");
        ctx.animate(layer.id, "sharpen", motion({ name: "Swing sharp", start: swingAt + swing * 0.3, duration: swing * 0.5, easing: CURVES.fade, from: { blur: smear }, to: { blur: rest } }), "plane");
      }
    }
    // The parts show while the move plays and the plane does: on with the shot, cut with the
    // plane's own hides and shows (a roll item), faded out (never popped: luma_jump) when the
    // move ends before the scene does.
    const cuts = [];
    let shown = true;
    const switches = (layer.animations ?? []).filter((animation) => isVisibilityOperation(animation) && animation.start > ctx.start + 1e-3 && animation.start < ctx.end - 1e-3);
    for (const time of [ctx.start, ...new Set(switches.map((animation) => animation.start).sort((a, b) => a - b))]) {
      if (visibleByOperations(layer.animations ?? [], time) === shown) continue;
      shown = !shown;
      cuts.push(shown ? show(time) : hide(time));
    }
    if (cuts.length) ctx.note(`the void and vignette hide and show with ${layer.id} (${cuts.length} cut${cuts.length === 1 ? "" : "s"})`);
    for (const part of [voidLayer, falloff, vignette].filter(Boolean)) {
      if (ctx.start > 0.001) ctx.animate(part, "show", show(ctx.start));
      cuts.forEach((cut, index) => ctx.animate(part, `cut${index + 1}`, cut));
      if (ctx.end >= ctx.sceneDuration - 0.001) continue;
      if (!(part === falloff && swingAt !== undefined)) ctx.animate(part, "out", motion({ name: "Fade out", kind: "out", start: ctx.end - FADE, duration: FADE, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(part, "hide", hide(ctx.end));
    }
    if (ctx.reduced && swingAt !== undefined) ctx.note("reduced motion: the plane cuts flat instead of swinging");
    return { end: ctx.end, tags: angle.rotateX ? ["orbit-3d", "drift"] : ["drift"] };
  },
};

/**
 * `frame` (backend/agent/blocks.mjs) puts a ui-plane in a camera group after the move placed its
 * swing's flat pose in the frame. Over each swing the camera left zoomed in goes home (no zoom,
 * no offset, the plane's flat pose centered), so the plane still lands flat at its size (90% of the frame when sharp).
 * Rebuilds the group's "Camera home" animations; the group is a top-level layer of a scene `frame` big.
 * A home is named for the move (<instance>.camera-home), so check times it with the swing as one
 * set piece and removing the move removes it.
 */
export function homeCamera(group, layers, frame) {
  const kept = (group.animations ?? []).filter((animation) => animation.name !== "Camera home");
  const homes = [];
  const own = (swing) => String(swing.id ?? "").endsWith(".plane-flat");
  const swings = layers.filter((layer) => layer.parentId === group.id)
    .flatMap((child) => (child.animations ?? []).filter((animation) => animation.name === "Swing flat").map((swing) => ({ child, swing })))
    .sort((a, b) => Number(own(b.swing)) - Number(own(a.swing)));
  for (const { child, swing } of swings) {
    if (homes.some((home) => home.start === swing.start)) continue;
    const before = evaluateLayer({ ...group, animations: kept.filter((animation) => (animation.start ?? 0) < swing.start) }, swing.start);
    const from = { x: round(before.x, 2), y: round(before.y, 2), scaleX: round(before.scaleX ?? 1, 4), scaleY: round(before.scaleY ?? 1, 4) };
    const to = { x: round(frame.width / 2 - (swing.to.x + child.width / 2), 2), y: round(frame.height / 2 - (swing.to.y + child.height / 2), 2), scaleX: 1, scaleY: 1 };
    if (Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5 && Math.abs(from.scaleX - 1) < 1e-3 && Math.abs(from.scaleY - 1) < 1e-3) continue;
    const id = own(swing) ? `${String(swing.id).slice(0, -".plane-flat".length)}.camera-home` : `${group.id}.home-${homes.length + 1}`;
    homes.push({ id, name: "Camera home", kind: "custom", start: swing.start, duration: swing.duration, easing: swing.easing, unit: "layer", stagger: 0, order: "forward", from, to });
  }
  group.animations = [...kept, ...homes];
  return homes.length;
}
