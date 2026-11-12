// ask_unmet: the person's subject is in no footage the edit shows. kino searched titles about the
// subject the person named (state.origin) and found a word most of them share (a "tower" in 11 of
// 15 titles about a "keeper"). A file title with the word is not proof: a clip titled "tower" may
// never show the tower in the seconds the edit plays. The ask counts as met only when a shot shows
// it: the agent looked at that shot's source (look {mode:"source"}, kept in ctx.sourceLooks) and
// marked the frame that shows it (mark_subject {shows:"tower"}) inside the stretch the shot plays.
// A warning: the person sees it, and a scene waiver with a reason that names the word clears it.
//
// The agent service hands in ctx.origin {words: [{word, count, of}], top: [{title, ...}]} or
// {skipped}, ctx.scene, ctx.mediaNames {src: file title}, ctx.foundTitles (titles of clips kino
// found and imported), ctx.ownFootage (the person put a clip of their own in the project) and
// ctx.sourceLooks ({layerId: {src, at: [file seconds]}}).
import { sec } from "../analysis.js";
import { mediaFrameState, mediaPlaybackRange } from "../../playback.js";
import { LOOK_REACH } from "./footage.js";

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (title, word) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, "iu").test(String(title ?? ""));

// The origin words, most shared first.
const originWords = (origin) => [...(origin?.words ?? [])].filter((entry) => entry?.word).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

// The video layers a scene plays (enabled, shown, with a file).
const shownVideo = (scene) => (scene?.layers ?? []).filter((layer) => layer.type === "video" && layer.src && layer.enabled !== false && layer.visible !== false);

// The scene second at which `layer` plays file second `at` (nearest of 0.05 s steps), or null.
function sceneSecond(scene, layer, at) {
  const range = mediaPlaybackRange(layer, scene.duration);
  if (!range) return null;
  let best = null;
  for (let time = range.start; time <= range.end + 1e-9; time += 0.05) {
    const gap = Math.abs(mediaFrameState(layer, time).sourceTime - at);
    if (!best || gap < best.gap) best = { time, gap };
  }
  return best && best.gap <= 0.1 ? sec(best.time) : null;
}

/**
 * The shot that shows the ask: a mark (mark_subject with `shows` naming one of `words`) on a video
 * layer the scene plays, at a file second the layer plays and the agent looked at (a source look
 * of that layer and file within LOOK_REACH of it). {layer, word, at (file s), t (scene s)} or null.
 */
export function askShown(scene, words, sourceLooks) {
  for (const layer of shownVideo(scene)) {
    if (layer.subjectBoxes?.src !== layer.src) continue;
    const look = sourceLooks?.[layer.id];
    if (!look || look.src !== layer.src) continue;
    for (const box of layer.subjectBoxes.boxes ?? []) {
      const word = box.shows ? words.find((entry) => hasWord(box.shows, entry)) : null;
      if (!word || !(look.at ?? []).some((at) => Math.abs(at - box.at) <= LOOK_REACH)) continue;
      const t = sceneSecond(scene, layer, box.at);
      if (t != null) return { layer, word, at: box.at, t };
    }
  }
  return null;
}

/**
 * One line for the storyboard and rough-cut asks: what the person's ask points to and which shot
 * shows it, so they can check it themselves. "" without an origin word or a video layer.
 */
export function askLine(scene, origin, sourceLooks) {
  const words = originWords(origin);
  if (!words.length || !shownVideo(scene).length) return "";
  const [{ word, count, of }] = words;
  const shown = askShown(scene, words.map((entry) => entry.word), sourceLooks);
  const known = `"${word}" (in ${count} of ${of} titles about what you asked for)`;
  return shown ? `Your ask points to ${known}: ${shown.layer.name || shown.layer.id} shows it at ${shown.t} s.`
    : `Your ask points to ${known}: no shot is marked as showing it yet.`;
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
    call = `look {mode:"source", layer:"${name}", t:${middle}}, then on the frame that shows it edit {ops:[{op:"mark_subject", layer:"${name}", t:<scene s>, box:[x, y, w, h], shows:"${word}"}]}`;
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
