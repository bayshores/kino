// busy_edit: an edit that throws a different device at every shot reads as sloppy and jarring,
// however many designed moves it holds (a reviewer on one trailer: "a lot going on, but
// ... sloppy, convoluted, and jarring"). Pro edits work the other way: most shots are plain
// cuts on the voice or the beat, one or two devices come back as a motif, the words keep one
// look, and the picture keeps one brightness. This rule measures those four things on the
// scene and warns when the edit is busy on any of them:
//   devices      distinct designed devices (moves by name, transitions, camera and set pieces)
//   move share   shots carrying a designed move, against plain cuts
//   text looks   entrance styles (a type move by name and color, other entrances by kind) and
//                each font family past the first
//   brightness   bright and dark shots alternating (a frame from each shot, when check renders)
// Principles, not a house style: which device or type look is used is never judged, only how
// many there are and how often they change. Warnings only: a busy edit is a taste problem, and
// a final-render gate here would fight plain_beats, which still asks for moves on plain shots.
import { techniqueOf } from "../../techniques.js";
import { readingTexts, sec } from "../analysis.js";
import { tweensOf } from "../model.js";
import { brightness } from "../motionPixels.js";
import { plateChanges, techniquesUsed, textEntrances, transitions } from "../techniques.js";
import { mediaPlaybackRange } from "../../playback.js";

// A title card or a sting shorter than this is one moment, not an edit (as in style.js).
const EDIT_SECONDS = 8;
// More distinct devices than this and none of them reads as a motif.
const DEVICE_LIMIT = 3;
// More shots than this share carrying a designed move and the moves stop being moments.
const MOVE_SHARE = 0.4;
// The move share is judged from this many shots (fewer is a sting, not an edit).
const MOVE_SHOTS = 5;
// More text looks than this (entrance styles, plus each family past the first) and the words
// stop reading as one voice.
const TEXT_LIMIT = 2;
// Two neighbor shots this many levels (0-255) apart in mean brightness are a swing...
const SWING = 64;
// ...and this many swings back and forth is bright and dark alternating.
const SWINGS = 3;
// A use this close before a shot (a transition into it) belongs to it.
const LEAD = 0.3;
// Small frames are enough for a mean brightness.
const LUMA_WIDTH = 160;
// A frame a shot: past this many shots the brightness part is left out (a check stays quick).
const LUMA_SHOTS = 60;

// Plain editing, not a device: a cut, a hold, cut timing, a fade to black at a chapter end, and
// the quiet camera any shot may have (a slow push or drift on the footage), and a blurred copy of
// the footage behind it (depth-blur: how a tall clip fills a wide frame). Type techniques are
// text looks, counted on their own.
const QUIET = new Set(["cut", "hold", "beat-cut", "syncopated", "fade-black", "slow-push", "drift", "motion-blur", "depth-blur", "type-cut"]);
const isType = (tag) => techniqueOf(tag)?.group === "type";

// The moves the scene holds (model.moves, from scene.moves: {id, name, tags, settings, start,
// end}) in time order. The model keeps the settings, so an edit receipt and a check agree.
function movesOf(model) {
  return (model.moves ?? []).filter((move) => move?.name && Number.isFinite(move.start)).sort((a, b) => a.start - b.start);
}
// A move that styles words (its first tag a type technique: stream, type-on, rewrite,
// masked-type, accent-hit) is a text look; the rest are devices.
const textMove = (move) => isType((move.tags ?? [])[0]);
// A type move's look: its name, and the color its words arrive in when it sets one (a pink
// stream and a dim stream are two looks).
const lookOf = (move) => (move.settings?.from ? `${move.name} from ${move.settings.from}` : move.name);
const madeBy = (move, at) => at >= move.start - LEAD && at <= (Number.isFinite(move.end) ? move.end : move.start) + LEAD;

// The shots to judge: the board's shots (cue and dur) inside the video, else the spans between
// shot changes (one full-frame picture giving way to another).
function shotsOf(model, ctx) {
  const board = (ctx.board ?? []).filter((shot) => Number.isFinite(shot.cue) && shot.dur > 0 && shot.cue < model.duration);
  if (board.length) return board.map((shot, index) => ({ n: index + 1, from: shot.cue, to: Math.min(model.duration, shot.cue + shot.dur) }));
  const edges = [0, ...plateChanges(model).map((change) => change.at), model.duration];
  return edges.slice(1).map((to, index) => ({ n: index + 1, from: edges[index], to })).filter((shot) => shot.to - shot.from > 0.05);
}

/**
 * What the edit uses: {devices: {name: [at]}, looks: {name: [at]}, families: [family],
 * shots: [{n, from, to, moved}]}. A technique a move made counts under the move's name once.
 * A device inside a signature range (style.signatureRanges) is the designed moment: not counted.
 */
function editVocabulary(model, ctx) {
  const moves = movesOf(model);
  const signature = (at) => (ctx.style?.signatureRanges ?? []).some(({ from, to }) => at >= from && at <= to);
  const devices = {};
  const looks = {};
  const add = (into, key, at) => (into[key] ??= []).push(sec(at));
  for (const move of moves) {
    if (textMove(move)) add(looks, lookOf(move), move.start);
    else if (!signature(move.start)) add(devices, move.name, move.start);
  }
  for (const [tag, uses] of Object.entries(techniquesUsed(model))) {
    if (QUIET.has(tag) || isType(tag) || (techniqueOf(tag)?.group === "rhythm" && tag !== "roll")) continue;
    for (const use of uses) if (!signature(use.at) && !moves.some((move) => madeBy(move, use.at) && (move.tags ?? []).includes(tag))) add(devices, tag, use.at);
  }
  // Text entrances no move made (a move made the layer, or one of its animations), by kind;
  // a plain cut-in is no look of its own.
  const byMove = (itemId) => Boolean(model.items.find((item) => item.id === itemId)?.move) || tweensOf(model, itemId).some((tween) => tween.move);
  for (const entry of textEntrances(model)) if (entry.tag && entry.tag !== "type-cut" && !byMove(entry.itemId)) add(looks, entry.tag, entry.at);
  const families = [...new Set(readingTexts(model).map((item) => item.fontFamily).filter(Boolean))];
  const uses = [...moves.map((move) => move.start).filter((at) => !signature(at)), ...Object.values(devices).flat()];
  const shots = shotsOf(model, ctx).map((shot) => ({ ...shot, moved: uses.some((at) => at >= shot.from - LEAD && at < shot.to - LEAD) }));
  return { devices, looks, families, shots };
}

const listed = (counts) => Object.entries(counts).sort((a, b) => b[1].length - a[1].length).map(([name, list]) => `${name} x${list.length}`).join(", ");
const keepOf = (counts, count) => Object.entries(counts).sort((a, b) => b[1].length - a[1].length || a[1][0] - b[1][0]).slice(0, count).map(([name]) => name);

// Mean brightness of one frame in the middle of each shot (clear of its transitions).
async function shotLevels(model, ctx, shots) {
  const times = shots.map((shot) => sec((shot.from + shot.to) / 2));
  const frames = await ctx.renderFrames(times, { width: Math.min(LUMA_WIDTH, model.width), hide: [] });
  return shots.map((shot, index) => ({ ...shot, level: frames[index] ? brightness(frames[index]) : null }));
}

// Swings between neighbor shots; a dark closing shot (an end mark on black) is left alone.
function swingFinding(ctx, leveled) {
  const swings = [];
  for (let index = 1; index < leveled.length; index += 1) {
    const [a, b] = [leveled[index - 1], leveled[index]];
    if (a.level === null || b.level === null || Math.abs(b.level - a.level) < SWING) continue;
    if (index === leveled.length - 1 && b.level < a.level) continue;
    swings.push({ at: b.from, n: b.n, up: b.level > a.level, from: a.level, to: b.level });
  }
  if (swings.length < SWINGS || swings.every((swing) => swing.up) || swings.every((swing) => !swing.up)) return [];
  const dark = swings.map((swing) => (swing.up ? swing.n - 1 : swing.n));
  return [{
    rule: "busy_edit", severity: "warn", at: sec(swings[0].at), until: sec(swings.at(-1).at),
    measured: `${swings.length} brightness swings of ${SWING}+ levels (0-255) between shots (${swings.slice(0, 4).map((swing) => `${Math.round(swing.from)} to ${Math.round(swing.to)} at ${sec(swing.at)}s`).join(", ")})`,
    required: `fewer than ${SWINGS} bright-dark swings between neighbor shots`,
    message: `${ctx.sceneName} flips between bright and dark shots ${swings.length} times; the eye readjusts at every cut and the edit reads as jarring.`,
    fix: { kind: "hint", text: `Keep one brightness: lift the dark shots (${[...new Set(dark)].map((n) => `shot ${n}`).join(", ")}) toward the footage (a lighter backdrop, or the footage blurred behind the UI), grade the bright footage down, or keep the dark shots together in one section.` },
  }];
}

/** busy_edit: too many devices, too many moved shots, too many text looks, or alternating brightness. */
export function busyEdit(model, ctx) {
  if (model.duration < EDIT_SECONDS) return [];
  const { devices, looks, families, shots } = editVocabulary(model, ctx);
  const findings = [];
  const deviceNames = Object.keys(devices);
  if (deviceNames.length > DEVICE_LIMIT) {
    const keep = keepOf(devices, 2);
    findings.push({
      rule: "busy_edit", severity: "warn", at: sec(Math.min(...Object.values(devices).map((list) => list[0]))),
      measured: `${deviceNames.length} devices (${listed(devices)})`, required: `at most ${DEVICE_LIMIT} devices, one or two coming back as a motif`,
      message: `${ctx.sceneName} uses ${deviceNames.length} different devices; a new one at each shot reads as convoluted, not designed.`,
      fix: { kind: "hint", text: `Keep ${keep.join(" and ")} as the motif and make the other shots plain cuts on the voice or the beat (a move goes with {op:"move", id, name, remove:true}).` },
    });
  }
  const moved = shots.filter((shot) => shot.moved);
  if (shots.length >= MOVE_SHOTS && moved.length / shots.length > MOVE_SHARE) {
    findings.push({
      rule: "busy_edit", severity: "warn", at: sec(moved[0].from),
      measured: `${moved.length} of ${shots.length} shots carry a designed move (${Math.round((100 * moved.length) / shots.length)}%: shots ${moved.map((shot) => shot.n).join(", ")})`,
      required: `at most ${Math.round(MOVE_SHARE * 100)}% of shots; the rest plain cuts`,
      message: `${moved.length} of ${shots.length} shots in ${ctx.sceneName} carry a designed move, so none of them lands as a moment.`,
      fix: { kind: "hint", text: `Save moves for the hook, the turn and the payoff; let the shots between them play as plain cuts on the voice or the beat (remove a move with {op:"move", id, name, remove:true}).` },
    });
  }
  const lookNames = Object.keys(looks);
  const treatments = lookNames.length + Math.max(0, families.length - 1);
  if (treatments > TEXT_LIMIT) {
    const keep = keepOf(looks, 1);
    findings.push({
      rule: "busy_edit", severity: "warn", at: sec(Math.min(...Object.values(looks).map((list) => list[0]), model.duration)),
      measured: `${treatments} text looks (${[listed(looks), families.length > 1 ? `families ${families.join(", ")}` : ""].filter(Boolean).join("; ")})`,
      required: `at most ${TEXT_LIMIT}: one family, one or two ways words arrive (cut-ins aside)`,
      message: `Words in ${ctx.sceneName} arrive ${lookNames.length} ways${families.length > 1 ? ` in ${families.length} families` : ""}; one type style reads as one voice, a mix reads as sloppy.`,
      fix: { kind: "hint", text: `Pick one look${keep.length ? ` (${keep[0]} is the most used)` : ""} for the words and give the rest plain cut-ins in the same face and color${families.length > 1 ? ` (set_font to ${families[0]})` : ""}.` },
    });
  }
  if (!ctx.renderFrames || shots.length < SWINGS + 1 || shots.length > LUMA_SHOTS) return findings;
  return shotLevels(model, ctx, shots).then((leveled) => [...findings, ...swingFinding(ctx, leveled)]);
}

// ---------------------------------------------------------------- restraint

// Restraint defaults: the
// "AI edit" look comes from stacking, not from any one effect. Four things, warnings only:
//   transition    a non-cut transition (dissolve, push, whip) away from a shot change
//   stacked grade two color grades (curves, LUT, wheels, white balance, hue) on one layer at once
//   reused        one moment of a footage file shown twice (source ranges overlapping 0.5 s)
//   letterboxed   footage filling the frame one way and leaving bars the other way for 1 s
const GRADES = new Set(["curves", "lut", "color-wheels", "white-balance", "hue-saturation"]);
// A transition this close to a shot change belongs to it.
const AT_CHANGE = 0.35;
// Two uses of one file overlapping this long in the file are one moment shown twice.
const REUSE = 0.5;
// Bars: the clip spans 97% of the frame one way and under 90% the other way, this long.
const BAR_SPAN = 0.97;
const BAR_GAP = 0.9;
const BAR_SECONDS = 1;
const TRANSITION_TAGS = new Set(["dissolve", "blur-through", "zoom-through", "whip-pan", "mask-wipe", "glitch-hit", "flash", "push-transition"]);

function strayTransitions(model) {
  const changes = plateChanges(model).map((change) => change.at);
  const found = [];
  for (const [tag, uses] of Object.entries(techniquesUsed(model))) {
    if (!TRANSITION_TAGS.has(tag)) continue;
    for (const use of uses) if (!changes.some((at) => Math.abs(at - use.at) <= AT_CHANGE)) found.push({ tag, at: use.at });
  }
  // The shot changes' own transitions are at a change by definition; only strays are left.
  return found.filter((entry) => !transitions(model).some((change) => change.tag === entry.tag && Math.abs(change.at - entry.at) <= AT_CHANGE));
}

// A color_filter look is made of a few grades (engine/colorFilter.js names them "Filter <look>",
// "Filter <look> 2", ...; a cut-out's copy keeps the names): together they are one look, not
// grades stacked on a grade.
const filterLook = (entry) => /^Filter ([a-z-]+)(?: \d+)?$/.exec(String(entry.name ?? ""))?.[1] ?? null;

function stackedGrades(model) {
  const grades = (model.effects ?? []).filter((entry) => GRADES.has(entry.effect));
  const found = [];
  for (let a = 0; a < grades.length; a += 1) for (let b = a + 1; b < grades.length; b += 1) {
    const [one, two] = [grades[a], grades[b]];
    if (filterLook(one) && filterLook(one) === filterLook(two)) continue;
    const from = Math.max(one.start, two.start), to = Math.min(one.end ?? model.duration, two.end ?? model.duration);
    if (one.itemId === two.itemId && to - from > 0.1) found.push({ itemId: one.itemId, at: from, effects: [one.effect, two.effect] });
  }
  return found;
}

function reusedMoments(ctx, duration) {
  const clips = (ctx.scene?.layers ?? []).filter((layer) => layer.type === "video" && layer.src && layer.visible !== false).map((layer) => {
    const range = mediaPlaybackRange(layer, duration);
    if (!range || range.remapped) return null;
    const speed = Math.abs(layer.mediaSpeed ?? 1) || 1;
    return { layer, at: range.start, from: range.offset, to: range.offset + range.duration * speed };
  }).filter(Boolean);
  const found = [];
  for (let a = 0; a < clips.length; a += 1) for (let b = a + 1; b < clips.length; b += 1) {
    const [one, two] = [clips[a], clips[b]];
    if (one.layer.src !== two.layer.src) continue;
    const overlap = Math.min(one.to, two.to) - Math.max(one.from, two.from);
    // A copy under itself (a blurred backdrop of the same clip at the same time) is one shot.
    if (overlap >= REUSE && Math.abs(one.at - two.at) > REUSE) found.push({ ids: [one.layer.id, two.layer.id], at: Math.max(one.at, two.at), file: sec(Math.max(one.from, two.from)), overlap });
  }
  return found;
}

function letterboxed(model) {
  const found = [];
  const videos = model.items.filter((entry) => entry.kind === "video");
  for (const item of videos) {
    // A copy of the clip behind it (a blurred fill) is how a tall clip fills a wide frame: no bars.
    if (videos.some((other) => other !== item && other.src && other.src === item.src)) continue;
    let run = 0;
    for (let index = 0; index < model.times.length; index += 1) {
      const { x0, y0, x1, y1, opacity } = item.samples;
      const wide = (x1[index] - x0[index]) / model.width, tall = (y1[index] - y0[index]) / model.height;
      const barred = opacity[index] >= 0.5 && ((wide >= BAR_SPAN && tall < BAR_GAP && tall > 0.3) || (tall >= BAR_SPAN && wide < BAR_GAP && wide > 0.3));
      run = barred ? run + 1 : 0;
      if (run / model.fps >= BAR_SECONDS) { found.push({ itemId: item.id, at: model.times[index - run + 1], wide, tall }); break; }
    }
  }
  return found;
}

/** restraint: a transition off a shot change, a grade stacked on a grade, a footage moment used twice, letterboxed footage. */
export function restraint(model, ctx) {
  const findings = [];
  const warn = (fields) => findings.push({ rule: "restraint", severity: "warn", ...fields });
  for (const stray of strayTransitions(model).slice(0, 3)) warn({
    at: sec(stray.at), measured: `${stray.tag} at ${sec(stray.at)} s, no shot change within ${AT_CHANGE} s`, required: "transitions only where one shot gives way to another",
    message: `A ${stray.tag} at ${sec(stray.at)} s in ${ctx.sceneName} is not at a shot change: an effect between changes reads as decoration.`,
    fix: { kind: "hint", text: "Move it onto the cut it belongs to, or remove it." },
  });
  for (const stack of stackedGrades(model)) warn({
    itemId: stack.itemId, at: sec(stack.at), measured: `${stack.effects.join(" + ")} on one layer at ${sec(stack.at)} s`, required: "one grade at a time: a new look replaces the old one",
    message: `${ctx.name(model.items.find((item) => item.id === stack.itemId))} has two grades at once (${stack.effects.join(" and ")}); stacked looks muddy the picture.`,
    fix: { kind: "hint", text: "End the first grade where the second starts, or keep one and set its values." },
  });
  for (const reuse of reusedMoments(ctx, model.duration)) warn({
    itemIds: reuse.ids, at: sec(reuse.at), measured: `${reuse.ids.join(" and ")} show the same ${sec(reuse.overlap)} s of their file (from ${reuse.file} s)`, required: "each footage moment used once",
    message: `The same footage moment plays twice in ${ctx.sceneName} (${reuse.ids.join(", ")}); a viewer notices the repeat.`,
    fix: { kind: "hint", text: "Give the second use another part of the file (mediaOffset) or another clip." },
  });
  for (const bar of letterboxed(model)) warn({
    itemId: bar.itemId, at: sec(bar.at), measured: `footage ${Math.round(bar.wide * 100)}% wide, ${Math.round(bar.tall * 100)}% tall for ${BAR_SECONDS} s+`, required: "B-roll fills the frame (no bars)",
    message: `${ctx.name(model.items.find((item) => item.id === bar.itemId))} leaves bars at ${sec(bar.at)} s: letterboxed B-roll looks unfinished.`,
    fix: { kind: "hint", text: "Fill the frame (fit cover, then mark_subject so the crop keeps it), or put a blurred copy of the clip behind it." },
  });
  return findings;
}
