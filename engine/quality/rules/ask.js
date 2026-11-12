// ask_unmet: the person's subject is in no footage the edit shows. kino searched titles about the
// subject the person named (state.origin) and found a word most of them share (a "tower" in 11 of
// 15 titles about a "keeper"). A file title with the word is not proof: a clip titled "tower" may
// never show the tower in the seconds the edit plays. The ask counts as met only when a shot shows
// it: the agent looked at that shot's source (look {mode:"source"}, kept in ctx.sourceLooks) and
// marked the frame that shows it (mark_subject {shows:"tower"}, kept in layer.askShows, apart from
// the subject boxes) inside the stretch the shot plays.
// A warning: the person sees it, and a scene waiver with a reason that names the word clears it.
//
// The agent service hands in ctx.origin {words: [{word, count, of}], top: [{title, ...}]} or
// {skipped}, ctx.scene, ctx.mediaNames {src: file title}, ctx.foundTitles (titles of clips kino
// found and imported), ctx.ownFootage (the person put a clip of their own in the project) and
// ctx.sourceLooks ({layerId: {src, at: [file seconds]}}).
import { sec } from "../analysis.js";
import { mediaPlaybackRange, mediaSceneTime } from "../../playback.js";
import { LOOK_REACH } from "./footage.js";

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (title, word) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, "iu").test(String(title ?? ""));

// The origin words, most shared first.
const originWords = (origin) => [...(origin?.words ?? [])].filter((entry) => entry?.word).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

// The video layers a scene plays (enabled, shown, with a file).
const shownVideo = (scene) => (scene?.layers ?? []).filter((layer) => layer.type === "video" && layer.src && layer.enabled !== false && layer.visible !== false);

// The scene second at which `layer` plays file second `at` (any clip speed), or null when its Play range never does.
function sceneSecond(scene, layer, at) {
  const range = mediaPlaybackRange(layer, scene.duration);
  const time = range ? mediaSceneTime(layer, at) : null;
  return time != null && time >= range.start - 0.05 && time <= range.end + 0.05 ? sec(Math.min(Math.max(time, range.start), range.end)) : null;
}

/**
 * The shot that shows the ask: a mark (mark_subject with `shows` naming one of `words`, kept in
 * layer.askShows apart from the subject boxes) on a video layer the scene plays, at a file second
 * the layer plays and the agent looked at (a source look of that layer and file within LOOK_REACH
 * of it). {layer, word, at (file s), t (scene s)} or null.
 */
export function askShown(scene, words, sourceLooks) {
  for (const layer of shownVideo(scene)) {
    if (layer.askShows?.src !== layer.src) continue;
    const look = sourceLooks?.[layer.id];
    if (!look || look.src !== layer.src) continue;
    for (const mark of layer.askShows.marks ?? []) {
      const word = words.find((entry) => hasWord(mark.what, entry));
      if (!word || !(look.at ?? []).some((at) => Math.abs(at - mark.at) <= LOOK_REACH)) continue;
      const t = sceneSecond(scene, layer, mark.at);
      if (t != null) return { layer, word, at: mark.at, t };
    }
  }
  return null;
}

/**
 * One line for the storyboard and rough-cut asks: what the person's ask points to and which shot
 * shows it, so they can check it themselves. `board` (the storyboard's shots, {cue, dur}) makes
 * it name the shot number. `own` (the person gave footage) and `waived` (the reason of an
 * ask_unmet waiver on the scene) match the check, which is silent then. "" without an origin
 * word, a video layer, or when the person's own footage is the footage.
 */
export function askLine(scene, origin, sourceLooks, { board = null, own = false, waived = null } = {}) {
  const words = originWords(origin);
  if (!words.length || !shownVideo(scene).length || own) return "";
  const [{ word, count, of }] = words;
  const known = `"${word}" (in ${count} of ${of} titles about what you asked for)`;
  if (waived) return `Your ask points to ${known}: not shown, on purpose (${String(waived).slice(0, 80)}).`;
  const shown = askShown(scene, words.map((entry) => entry.word), sourceLooks);
  if (!shown) return `Your ask points to ${known}: no shot is marked as showing it yet.`;
  const index = board ? board.findIndex((shot) => shown.t >= shot.cue - 1e-6 && shown.t < shot.cue + shot.dur + 1e-6) : -1;
  return `Your ask points to ${known}: ${index >= 0 ? `shot ${index + 1}` : shown.layer.name || shown.layer.id} shows it at ${shown.t} s.`;
}

/** ask_unmet: no shot the scene plays is marked, after a look at its source, as showing the word the person's subject is known by. */
export function askUnmet(model, ctx) {
  const words = originWords(ctx.origin);
  const scene = ctx.scene ?? ctx.speechScene;
  if (!words.length || !scene || ctx.ownFootage || ctx.videoScene === false) return [];
  if (askShown(scene, words.map((entry) => entry.word), ctx.sourceLooks)) return [];
  const [{ word, count, of }] = words;
  const layers = shownVideo(scene);
  // The shot to look at first: one whose file title has the word, else the first shot.
  const titled = layers.filter((layer) => hasWord(ctx.mediaNames?.[layer.src], word));
  const found = (ctx.foundTitles ?? []).filter((title) => hasWord(title, word)).length;
  const top = ctx.origin.top?.[0]?.title ? ` (the most watched: "${ctx.quote(ctx.origin.top[0].title)}")` : "";
  const waive = `If the edit rightly shows something else, waive_check ask_unmet on the scene with a reason that names "${word}".`;
  const target = titled[0] ?? layers[0];
  let call;
  if (target) {
    const name = target.name || target.id;
    const range = mediaPlaybackRange(target, scene.duration);
    const middle = sec(range ? (range.start + range.end) / 2 : 0);
    call = `look {mode:"source", layer:"${name}", t:${middle}}, then on the frame that shows it edit {ops:[{op:"mark_subject", layer:"${name}", t:<scene s>, shows:"${word}"}]}`;
  }
  const search = `library {topic:"footage", search:"<their subject> ${word}"}, then scan with want:"${word}"`;
  const fix = titled.length ? `${call}.` : target ? `${call}; if no shot shows it: ${search}.` : `${search}.`;
  const why = titled.length
    ? `${titled.length} shot${titled.length === 1 ? "'s" : "s'"} file title${titled.length === 1 ? " has" : "s have"} it, but a title is not the picture: no shot is marked as showing it after a look`
    : found ? `a found clip's title has it, but no shot is marked as showing it after a look` : "no shot shows it";
  return [{
    rule: "ask_unmet", severity: "warn", at: 0, until: sec(model.duration),
    message: `${fix} "${word}" is in ${count} of ${of} titles about what the person asked for${top}; ${why}.`,
    measured: `"${word}" in ${count} of ${of} titles about their subject; ${layers.length} shot${layers.length === 1 ? "" : "s"}, ${titled.length} titled with it, none marked shows:"${word}" at a looked-at second; none of the footage is the person's own`,
    required: `a shot marked shows:"${word}" (mark_subject) at a second you looked at (look {mode:"source"}), the person's own footage, or a scene waiver whose reason names "${word}"`,
    fix: { kind: "hint", text: `${fix} ${waive}` },
  }];
}
