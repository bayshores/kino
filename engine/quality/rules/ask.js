// ask_unmet: the person's subject is in no footage the edit shows. kino searched titles about the
// subject the person named (state.origin) and found a word most of them share (a "tower" in 11 of
// 15 titles about a "keeper"). If the person gave no footage of their own and no shot's file title,
// nor any found clip's title, has that word, the edit probably shows something else. A warning:
// the person sees it, and a scene waiver with a reason that names the word clears it.
//
// The agent service hands in ctx.origin {words: [{word, count, of}], top: [{title, ...}]} or
// {skipped}, ctx.scene, ctx.mediaNames {src: file title}, ctx.foundTitles (titles of clips kino
// found and imported) and ctx.ownFootage (the person put a clip of their own in the project).
import { sec } from "../analysis.js";

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (title, word) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, "iu").test(String(title ?? ""));

/** ask_unmet: no shot's file title or found clip's title has the word the person's subject is known by. */
export function askUnmet(model, ctx) {
  const words = [...(ctx.origin?.words ?? [])].filter((entry) => entry?.word).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const scene = ctx.scene ?? ctx.speechScene;
  if (!words.length || !scene || ctx.ownFootage || ctx.videoScene === false) return [];
  const shown = (scene.layers ?? []).filter((layer) => layer.type === "video" && layer.src && layer.enabled !== false).map((layer) => ctx.mediaNames?.[layer.src]);
  const titles = [...shown, ...(ctx.foundTitles ?? [])].filter(Boolean);
  if (words.some(({ word }) => titles.some((title) => hasWord(title, word)))) return [];
  const [{ word, count, of }] = words;
  const top = ctx.origin.top?.[0]?.title ? ` (the most watched: "${ctx.quote(ctx.origin.top[0].title)}")` : "";
  return [{
    rule: "ask_unmet", severity: "warn", at: 0, until: sec(model.duration),
    message: `"${word}" is in ${count} of ${of} titles about what the person asked for${top}, and in no shot's title: the edit may not show what they asked about.`,
    measured: `"${word}" in ${count} of ${of} titles about their subject; ${titles.length} footage title${titles.length === 1 ? "" : "s"} checked, none has it; none of the footage is the person's own`,
    required: `a shot or found clip titled with "${word}", the person's own footage, or a scene waiver whose reason names "${word}"`,
    fix: { kind: "hint", text: `Find footage of it: library {topic:"footage", search:"<their subject> ${word}"}, then scan with want:"${word}". If the edit rightly shows something else, waive_check ask_unmet on the scene with a reason that names "${word}".` },
  }];
}
