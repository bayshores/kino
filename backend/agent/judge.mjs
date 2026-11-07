// Judge rounds: the person picks blind which of two frames looks more finished, one from the
// edit and one from a reference they saved (inspire). Agents overrate their own edits; the counts
// go back to the agent's inbox so it cannot call a weak edit finished.
//
// A round (notes {action:"judge"}) is made in the background: up to 10 pairs, each an edit frame
// and a reference still at the same point in the story (the same fraction of each), drawn at the
// same pixel size and saved as JPEGs with the same quality, on random sides. Which side is the
// edit stays here (the dashboard sees it only when the round is done). Rounds are kept in the
// project's agent state (`judges`, the last 10), the pictures under <agent>/judge/<project>/.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { ideaLines } from "../../engine/quality/rules/signature.js";
import { styleContext } from "../../engine/styleSpec.js";
import { MOVE_REF } from "../../engine/board.js";

export const MAX_PAIRS = 10;
export const PAIR_HEIGHT = 360;
export const PAIR_MAX_WIDTH = 640;
export const PICKS = ["left", "right", "same", "skip"];
// look {mode:"versus"} shows at most this many pairs, one a row.
export const VERSUS_ROWS = 6;
const ROUNDS_KEPT = 10;
// How long a round waits for one saved reference to be measured again (it needs stills).
const REMEASURE_WAIT_MS = 4 * 60 * 1000;
const even = (value) => Math.max(2, Math.round(value / 2) * 2);
const sec = (value) => Math.round(value * 100) / 100;
// A pinned still farther than this from the pinned second is said in the versus row.
const PIN_NEAR = 0.6;

/** The pixel size both pictures of a pair are drawn at: the edit's shape, 360 px tall, at most 640 wide. */
export function pairSize(width, height) {
  const aspect = width / height;
  const w = PAIR_HEIGHT * aspect;
  return w > PAIR_MAX_WIDTH ? { width: PAIR_MAX_WIDTH, height: even(PAIR_MAX_WIDTH / aspect) } : { width: even(w), height: PAIR_HEIGHT };
}

/** How many pairs a video of `seconds` gets: one per 2 s, 3 to 10. */
export const pairCount = (seconds) => Math.min(MAX_PAIRS, Math.max(3, Math.round(seconds / 2)));

/**
 * The pairs of a round: for each, the scene and time of the edit frame and the reference still,
 * at the same fraction of each video. `scenes` [{id, name, duration}] in order; `refs` from
 * inspire.savedStills; `random` picks the edit's side.
 */
export function planPairs(scenes, refs, random = Math.random, most = MAX_PAIRS) {
  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (!(total > 0) || !refs.length) return [];
  const count = Math.min(most, pairCount(total));
  return Array.from({ length: count }, (_, index) => {
    const fraction = (index + 0.5) / count;
    let at = fraction * total, scene = scenes[0];
    for (scene of scenes) { if (at < scene.duration) break; at -= scene.duration; }
    const ref = refs[index % refs.length];
    const still = ref.stills[Math.min(ref.stills.length - 1, Math.floor(fraction * ref.stills.length))];
    return { n: index + 1, sceneId: scene.id, scene: scene.name ?? null, t: sec(Math.min(at, scene.duration)), at: sec(fraction * total),
      ref: ref.id, refAt: still.at, still: path.join(ref.folder, still.file), edit: random() < 0.5 ? "left" : "right", pick: null };
  });
}

/**
 * The saved reference a board key names ("phone-film", "yt:<id>" or "<id>"): the one saved with that
 * key (save yt:<id> as phone-film), or with that id, else the only one whose title or channel has
 * every word of the key ("agent-launch" finds "Agent launch"). null when none or several match.
 */
export function refForKey(refs, key) {
  const want = String(key ?? "").trim().toLowerCase();
  const exact = refs.find((ref) => (ref.keys ?? []).includes(want) || [want, `yt:${want}`].includes(String(ref.id).toLowerCase()));
  if (exact || !want) return exact ?? null;
  const words = want.split(/[-_]+/).filter(Boolean);
  const named = refs.filter((ref) => {
    const have = new Set(`${ref.title ?? ""} ${ref.channel ?? ""}`.toLowerCase().split(/[^a-z0-9]+/));
    return words.every((word) => have.has(word));
  });
  return named.length === 1 ? named[0] : null;
}

/**
 * look versus rows for the board's pinned moments: each shot whose move.ref ("phone-film@3.13") names
 * a saved reference is paired, at the shot's middle, with that reference's still nearest the
 * pinned second. { pairs, missing, waiting }: missing lists the refs no saved reference matched,
 * waiting those whose reference is saved but has no stills yet (still being measured).
 */
export function pinnedPairs(board, sceneId, refs, most = VERSUS_ROWS) {
  const pairs = [], missing = [], waiting = [];
  (board?.shots ?? []).forEach((shot, index) => {
    const match = typeof shot?.move?.ref === "string" ? MOVE_REF.exec(shot.move.ref.trim()) : null;
    if (!match) return;
    const ref = refForKey(refs, match[1]);
    if (!ref?.stills?.length) { (ref ? waiting : missing).push(`shot ${index + 1} ${match[0]}`); return; }
    const second = Number(match[2]);
    const still = ref.stills.reduce((best, entry) => (Math.abs(entry.at - second) < Math.abs(best.at - second) ? entry : best));
    const t = sec(shot.cue + shot.dur / 2);
    pairs.push({ n: pairs.length + 1, sceneId, scene: null, t, at: t, ref: ref.id, refAt: still.at, still: path.join(ref.folder, still.file),
      edit: "left", pick: null, shot: index + 1, pinned: match[0],
      // An older save kept 10 stills spread over the video: the nearest can be far from the pin.
      ...(Math.abs(still.at - second) > PIN_NEAR ? { far: `pinned ${second} s, nearest still ${still.at} s; save the reference again for 1 s stills` } : {}) });
  });
  return { pairs: pairs.slice(0, most), missing, waiting };
}

/** The reference keys a board's shots pin (move.ref "phone-film@3.13" gives "phone-film"), each once. */
export function boardRefKeys(board) {
  const keys = (board?.shots ?? []).map((shot) => (typeof shot?.move?.ref === "string" ? MOVE_REF.exec(shot.move.ref.trim())?.[1] : null));
  return [...new Set(keys.filter(Boolean))];
}

/** Draws an image to fill `size` (cropped from the middle), as a JPEG (or `type`). */
export async function coverImage(source, size, type = "image/jpeg") {
  const image = await loadImage(source);
  const canvas = createCanvas(size.width, size.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, size.width, size.height);
  const scale = Math.max(size.width / image.width, size.height / image.height);
  const w = image.width * scale, h = image.height * scale;
  context.drawImage(image, (size.width - w) / 2, (size.height - h) / 2, w, h);
  return type === "image/jpeg" ? canvas.toBuffer(type, 85) : canvas.toBuffer(type);
}

const pairFile = (round, n, side) => `${round}-${String(n).padStart(2, "0")}-${side}.jpg`;

/** The counts of a done round: {references, same, yours, skipped, lost: [pairs the reference won]}. */
export function tally(round) {
  const counts = { references: 0, same: 0, yours: 0, skipped: 0, lost: [] };
  for (const pair of round.pairs) {
    if (pair.pick === "same") counts.same += 1;
    else if (pair.pick === "skip" || !pair.pick) counts.skipped += 1;
    else if (pair.pick === pair.edit) counts.yours += 1;
    else { counts.references += 1; counts.lost.push(pair); }
  }
  return counts;
}

/** The agent's inbox line for a done round. */
export function resultText(round) {
  const counts = tally(round);
  const scenes = new Set(round.pairs.map((pair) => pair.sceneId)).size;
  const where = (pair) => (scenes > 1 && pair.scene ? `"${pair.scene}" @${pair.t}s` : `@${pair.at}s`);
  return `judged rev ${round.rev}: references ${counts.references} · same ${counts.same} · yours ${counts.yours}${counts.skipped ? ` · skipped ${counts.skipped}` : ""}`
    + (counts.lost.length ? `\nthe reference looked more finished at ${counts.lost.map(where).join(", ")}: work there before you call it finished.` : "");
}

/** The latest round of revision `rev` (not a failed one) in an agent state, or null. */
export const latestRound = (state, rev) => (state.judges ?? []).findLast((round) => round.rev === rev && round.status !== "failed") ?? null;

/** The done round of revision `rev` where the references won more pairs than yours and same together, or null. */
export function judgeLost(state, rev) {
  const round = latestRound(state, rev);
  if (round?.status !== "done") return null;
  const counts = tally(round);
  return counts.references > counts.yours + counts.same ? round : null;
}

/** One line on the judge round of revision `rev` (look versus). */
export function judgeLine(state, rev) {
  const round = latestRound(state, rev);
  if (!round) return `no judge round for rev ${rev}: notes {action:"judge"} asks the person to pick blind.`;
  return round.status === "done" ? resultText(round) : `judge ${round.id} (rev ${rev}) waits for the person's picks.`;
}

/** What the dashboard sees of a round: no sides until it is done. */
export function roundView(round) {
  if (!round) return null;
  const finished = round.status === "done";
  return { id: round.id, rev: round.rev, status: round.status, ...(round.error ? { error: round.error } : {}), ...(round.idea?.length ? { idea: round.idea } : {}),
    pairs: (round.pairs ?? []).map((pair) => ({ n: pair.n, pick: pair.pick, files: [pairFile(round.id, pair.n, 1), pairFile(round.id, pair.n, 2)],
      ...(finished ? { edit: pair.edit, at: pair.at, ref: pair.ref } : {}) })) };
}

/** The latest round of an agent state, as the dashboard sees it. */
export const judgeView = (state) => roundView(state.judges?.at(-1));

/**
 * deps: agentState, inspire (savedStills, projectView), directory (<agent>/judge), emit(projectId,
 * event), editFrame(document, sceneId, time, width) → PNG buffer, now, random.
 */
export function createJudge(deps) {
  const { agentState, inspire, directory } = deps;
  const now = deps.now ?? Date.now;
  const folderOf = (projectId) => path.join(directory, encodeURIComponent(projectId));
  const publish = async (projectId) => deps.emit?.(projectId, { kind: "judge", judge: judgeView(await agentState.read(projectId)) });

  async function hasSaved(projectId) {
    const view = await inspire?.projectView?.(projectId).catch(() => null);
    return Boolean(view?.saved?.length);
  }

  /** The round of revision `rev` that is being made, open or done, or null. */
  const roundFor = async (projectId, rev) => latestRound(await agentState.read(projectId), rev);

  /**
   * Starts a round for `record` (the project as it is now) and returns it at once; the pictures
   * are made in the background. A round of this revision already made or open is returned instead.
   */
  async function start(record, { by = "agent" } = {}) {
    const projectId = record.document.id;
    const rev = record.revision;
    const existing = await roundFor(projectId, rev);
    if (existing) return { round: existing, existing: true };
    const round = await agentState.update(projectId, (state) => {
      const judges = state.judges ?? [];
      // The edit's idea and signature (style.idea, style.signatures): the person picks with them in mind.
      const idea = ideaLines(styleContext(state.brief?.style));
      const made = { id: `J${(judges.at(-1)?.number ?? 0) + 1}`, number: (judges.at(-1)?.number ?? 0) + 1, rev, by, status: "preparing", createdAt: new Date(now()).toISOString(), pairs: [], ...(idea.length ? { idea } : {}) };
      state.judges = [...judges, made].slice(-ROUNDS_KEPT);
      return made;
    });
    await publish(projectId);
    prepare(record, round.id).catch(() => {});
    return { round, existing: false };
  }

  async function finish(projectId, id, change) {
    const round = await agentState.update(projectId, (state) => {
      const found = (state.judges ?? []).find((entry) => entry.id === id);
      if (found) change(found, state);
      return found ? structuredClone(found) : null;
    });
    await publish(projectId);
    return round;
  }

  async function prepare(record, id) {
    const projectId = record.document.id;
    try {
      const refs = await inspire.savedStills(projectId, { wait: REMEASURE_WAIT_MS });
      if (!refs.length) throw new Error("no saved reference has stills yet (it could not be measured again)");
      const scenes = record.document.scenes.map((scene) => ({ id: scene.id, name: scene.name, duration: scene.duration, width: scene.width, height: scene.height }));
      const pairs = planPairs(scenes, refs, deps.random ?? Math.random);
      const folder = folderOf(projectId);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      // Only this round's pictures are kept.
      for (const name of await readdir(folder).catch(() => [])) if (!name.startsWith(`${id}-`)) await rm(path.join(folder, name), { force: true });
      for (const pair of pairs) {
        const scene = scenes.find((entry) => entry.id === pair.sceneId);
        const size = pairSize(scene.width, scene.height);
        const edit = await coverImage(await deps.editFrame(record.document, pair.sceneId, pair.t, size.width), size);
        const reference = await coverImage(pair.still, size);
        const [left, right] = pair.edit === "left" ? [edit, reference] : [reference, edit];
        await writeFile(path.join(folder, pairFile(id, pair.n, 1)), left, { mode: 0o600 });
        await writeFile(path.join(folder, pairFile(id, pair.n, 2)), right, { mode: 0o600 });
        delete pair.still;
      }
      await finish(projectId, id, (round) => { round.pairs = pairs; round.status = "open"; });
    } catch (error) {
      const words = String(error?.message ?? error).split("\n")[0].slice(0, 200);
      await finish(projectId, id, (round, state) => {
        round.status = "failed";
        round.error = words;
        state.inbox.push({ kind: "judge", text: `judge ${id} (rev ${round.rev}) could not start: ${words}` });
      });
    }
  }

  /** The person's pick on pair `n` of round `id`. Returns the round; when every pair has a pick, it is done and the agent hears the counts. */
  async function pick(projectId, { id, n, pick: choice }) {
    if (!PICKS.includes(choice)) throw new Error(`pick is ${PICKS.join(", ")}.`);
    const round = await finish(projectId, id, (found, state) => {
      if (found.status !== "open") return;
      const pair = found.pairs.find((entry) => entry.n === n);
      if (!pair) return;
      pair.pick = choice;
      if (found.pairs.every((entry) => entry.pick)) {
        found.status = "done";
        found.doneAt = new Date(now()).toISOString();
        state.turnBreak = true;
        state.inbox.push({ kind: "judge", text: resultText(found) });
      }
    });
    if (!round) throw new Error(`No judge round ${id}.`);
    return round;
  }

  /** A final render approval was asked: a round starts by itself when the project has saved references and this revision has none. */
  async function auto(record) {
    if (!(await hasSaved(record.document.id))) return null;
    if (await roundFor(record.document.id, record.revision)) return null;
    return (await start(record, { by: "kino" })).round;
  }

  /** The file of one picture of the latest round, or null. */
  function file(projectId, name) {
    return /^J\d+-\d{2}-[12]\.jpg$/.test(name) ? path.join(folderOf(projectId), name) : null;
  }

  return { start, pick, auto, hasSaved, file };
}
