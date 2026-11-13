// Try rounds (storyboard v4, "try options"): the agent asks one question about a moment of the
// video ("which cut into shot 2?") with 2 to 4 options, each a list of edit ops. kino makes the
// video once per option (the ops on a copy, nothing saved) and renders the 2 s around the moment,
// one option after another; the person plays them side by side on the dashboard and picks one,
// none of these, or skip. The answer goes to the agent's inbox with the picked option's ops, so
// the video is built up round by round from the person's picks.
//
// Rounds are kept in the project's agent state (`tries`, the last 12; `tryLater`, the topics the
// agent plans next), the clips under <agent>/try/<project>/<T1-B.mp4>.
//
// A sketch round (sketches.mjs) is a try round over a stretch (from, to: 2 to 10 s) whose options
// each show one shown treatment; its clips carry their sound, are cached by their ops, and a pick
// of one also records that treatment as the person's pick (deps.pickTreatment).
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { isBuiltSketch, isSketchInput, readSketch, sketchCache, sketchCarry, sketchKey, sketchLines, treatmentOf } from "./sketches.mjs";

export const TRY_LETTERS = ["A", "B", "C", "D"];
export const TRY_ANSWERS = ["none", "skip"];
// Seconds of the video each side of the moment.
export const TRY_AROUND = 1;
const ROUNDS_KEPT = 12;
const LATER_MOST = 8;
const WORDS_MOST = 120;
const OPS_MOST = 4000;
const NOTE_MOST = 500;

const sec = (value) => Math.round(value * 100) / 100;
const words = (value, most) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, most);

/** The clip file of option `letter` of round `id`: "T1-B.mp4". */
export const clipName = (id, letter) => `${id}-${letter}.mp4`;

/**
 * Reads notes {action:"try"} (throws its words when a field is wrong): {question, topic, sceneId,
 * at, from, to, options:[{letter, name, ops}], later}. `scenes` are the document's [{id, duration}];
 * the moment is `at` seconds of `scene` (the first scene when left out).
 */
export function readTry(input, scenes, { treatments = null, known = false, empty = false } = {}) {
  const sketch = isSketchInput(input);
  const built = isBuiltSketch(input, empty);
  const question = words(input.question, WORDS_MOST) || (sketch ? "Which direction?" : "");
  if (!question) throw new Error('try needs question: what the person picks, "which cut into shot 2?".');
  const scene = input.scene === undefined ? scenes[0] : scenes.find((entry) => entry.id === input.scene || entry.name === input.scene);
  if (!scene) throw new Error(`scene ${JSON.stringify(input.scene)} is not in this project.`);
  const options = input.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > TRY_LETTERS.length)
    throw new Error(sketch ? 'options lists 2 to 4 sketches, each {treatment:"A", ops}: the ops that make this stretch that treatment.'
      : 'options lists 2 to 4 options, each {name, ops}: options:[{name:"plain cut", ops:[]}, {name:"whip pan", ops:[{op:"add_transition", ...}]}].');
  // A sketch round: its stretch, and the treatment each option shows (its name defaults to the treatment's move).
  const drawn = sketch ? readSketch(input, scene, treatments, known, built) : null;
  const read = options.map((option, index) => {
    const name = words(option?.name, 40) || drawn?.names[index] || "";
    if (!name) throw new Error(`options[${index}] needs a name (a few words the person reads under the video).`);
    const ops = option?.ops ?? [];
    if (!Array.isArray(ops)) throw new Error(`options[${index}].ops is a list of edit ops ([] keeps the video as it is).`);
    if (!sketch && JSON.stringify(ops).length > OPS_MOST) throw new Error(`options[${index}].ops is over ${OPS_MOST} characters: try one change at a time.`);
    return { letter: TRY_LETTERS[index], name, ops, ...(drawn?.treatments[index] ? { treatment: drawn.treatments[index], idea: drawn.ideas[index] } : {}),
      ...(drawn?.built ? { built: true, asked: drawn.built[index] } : {}) };
  });
  const names = read.map((option) => option.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error("Each option needs its own name.");
  const later = Array.isArray(input.later) ? input.later.map((topic) => words(topic, 30)).filter(Boolean).slice(0, LATER_MOST) : null;
  const topic = words(input.topic, 30) || question.replace(/\?$/, "").slice(0, 30);
  if (drawn) return { question, topic, sceneId: scene.id, at: drawn.from, from: drawn.from, to: drawn.to, options: read, later, sketch: true, ...(drawn.built ? { built: true } : {}) };
  const at = Number(input.at);
  if (!Number.isFinite(at) || at < 0 || at > scene.duration) throw new Error(`at is the moment in seconds, 0 to ${sec(scene.duration)} (the scene's length).`);
  // 2 s around the moment, moved inside the scene near its start or end.
  const from = Math.max(0, Math.min(at - TRY_AROUND, scene.duration - TRY_AROUND * 2));
  const to = Math.min(scene.duration, from + TRY_AROUND * 2);
  return { question, topic, sceneId: scene.id, at: sec(at), from: sec(from), to: sec(to), options: read, later };
}

/** What the dashboard sees: every round kept (the clips by name, no ops) and the topics planned next. */
export function triesView(state) {
  const rounds = (state.tries ?? []).map((round) => ({
    id: round.id, rev: round.rev, question: round.question, topic: round.topic, status: round.status, sceneId: round.sceneId, at: round.at, from: round.from, to: round.to,
    pick: round.pick ?? null, words: round.words ?? null, ...(round.error ? { error: round.error } : {}), ...(round.sketch ? { sketch: true } : {}),
    options: round.options.map((option) => ({ letter: option.letter, name: option.name, ready: Boolean(option.ready), ...(option.error ? { error: option.error } : {}),
      ...(option.treatment ? { treatment: option.treatment } : {}), file: clipName(round.id, option.letter) })),
  }));
  return { rounds, later: state.tryLater ?? [] };
}

/** The agent's inbox line once the person answered a round. */
export function answerText(round) {
  const head = `try ${round.id} "${round.question}"`;
  const said = round.words ? ` (their note: "${round.words}")` : "";
  if (round.pick === "skip") return `${head}: the person skipped it${said}. Keep the video as it is and go on to the next round.`;
  if (round.pick === "none") return `${head}: the person liked none of these${said}. Try other options: notes {action:"try"} again.`;
  const option = round.options.find((entry) => entry.letter === round.pick);
  if (option.built) {
    const song = option.song?.src ? `song "${option.song.title}" (${option.song.src}, ${option.song.from}-${option.song.to} s of the song)` : "no song";
    const used = `${song}, font ${option.font ?? "the default"}${option.line ? `, line "${option.line}"` : ""}`;
    const carried = !option.treatment || round.treatmentSaved ? `the sketch's ${used} are saved with the pick` : `the sketch used ${used}`;
    const saved = option.treatment ? (round.treatmentSaved ? `kino saved treatment ${option.treatment} as their pick (brief treatments, by them); status next names what follows`
      : `the sketch showed treatment ${option.treatment}${round.treatmentError ? `; kino did not save it as their pick: ${round.treatmentError}` : ""}`) : "";
    return `${head}: the person picked sketch ${option.letter} (${option.name})${said}; ${[saved, carried].filter(Boolean).join("; ")}.`;
  }
  if (round.sketch && option.treatment) {
    const saved = round.treatmentSaved ? `kino saved treatment ${option.treatment} as their pick (brief treatments, by them); status next names what follows`
      : round.treatmentError ? `the sketch showed treatment ${option.treatment}${option.idea ? ` ("${option.idea}")` : ""}; kino did not save it as their pick: ${round.treatmentError}`
        : `their treatment pick is ${option.treatment}: save it with notes brief fields:{treatments:{pick:"${option.treatment}", quote:"${pickQuote(round, option)}"}}`;
    return `${head}: the person picked sketch ${option.letter} (${option.name})${said}; ${saved}. The sketch's ops, if you keep them: edit {"ops":${JSON.stringify(option.ops)}}`;
  }
  const ops = option.ops.length ? `Apply it: edit {"ops":${JSON.stringify(option.ops)}}` : "It keeps the video as it is.";
  return `${head}: the person picked ${option.letter} (${option.name})${said}. ${ops} Then the next round starts from it.`;
}

/** The words a sketch pick is saved with as the treatment pick's quote (kept as said by them). */
export const pickQuote = (round, option) => `sketch ${option.letter} (${option.name}) picked on the dashboard in ${round.id}`;

/**
 * deps: agentState, directory (<agent>/try), emit(projectId, event), documentWith(record, ops) →
 * the document with the ops applied (nothing saved; throws the refusal's words), renderClip(document,
 * sceneId, from, to, outputPath, {sound}) writes that stretch of the video as an mp4 (silent unless
 * sound), now. For sketch rounds: briefOf(state) → {treatments, known} (the saved treatments and
 * whether D can be named), measureSketch(document, sceneId, from, to, file) → the clip's numbers
 * (sketches.mjs clipFacts), pickTreatment(state, round, option) saves the treatment pick on the
 * draft state (throws its words when it cannot), and cacheDirectory holds the clips by key.
 */
export function createTries(deps) {
  const { agentState, directory } = deps;
  const now = deps.now ?? Date.now;
  const folderOf = (projectId) => path.join(directory, encodeURIComponent(projectId));
  const cacheOf = (projectId) => sketchCache(path.join(deps.cacheDirectory ?? `${directory}-cache`, encodeURIComponent(projectId)));
  const publish = async (projectId) => deps.emit?.(projectId, { kind: "tries", tries: triesView(await agentState.read(projectId)) });

  async function change(projectId, id, edit) {
    const round = await agentState.update(projectId, (state) => {
      const found = (state.tries ?? []).find((entry) => entry.id === id);
      if (found) edit(found, state);
      return found ? structuredClone(found) : null;
    });
    await publish(projectId);
    return round;
  }

  /**
   * Starts a round for `record` (the project as it is now): every option's ops are tried on a
   * copy first, so a refused option refuses the whole round and nothing is kept. The clips are
   * rendered in the background. A round still waiting is replaced (its clips removed).
   */
  async function start(record, input, { by = "agent" } = {}) {
    const projectId = record.document.id;
    const brief = isSketchInput(input) ? (deps.briefOf?.(await agentState.read(projectId)) ?? {}) : {};
    const empty = record.document.scenes.every((scene) => Array.isArray(scene.layers) && !scene.layers.length);
    const read = readTry(input, record.document.scenes, { ...brief, empty });
    const documents = [];
    for (const option of read.built ? [] : read.options) {
      try { documents.push(await deps.documentWith(record, option.ops)); }
      catch (error) { throw new Error(`option ${option.letter} (${option.name}) was refused: ${String(error?.message ?? error).split("\n")[0]}`); }
    }
    const round = await agentState.update(projectId, (state) => {
      const kept = (state.tries ?? []).filter((entry) => entry.status !== "rendering" && entry.status !== "waiting");
      const number = Math.max(0, ...(state.tries ?? []).map((entry) => entry.number ?? 0)) + 1;
      const made = { id: `T${number}`, number, rev: record.revision, by, question: read.question, topic: read.topic, sceneId: read.sceneId, at: read.at, from: read.from, to: read.to,
        status: "rendering", createdAt: new Date(now()).toISOString(), options: read.options.map((option) => ({ ...option, ready: false })), pick: null, words: null,
        ...(read.sketch ? { sketch: true } : {}), ...(read.built ? { built: true } : {}) };
      state.tries = [...kept, made].slice(-ROUNDS_KEPT);
      if (read.later) state.tryLater = read.later;
      return structuredClone(made);
    });
    await publish(projectId);
    if (read.built) return { ...round, rendered: buildThenRender(record, round).catch(() => {}) };
    // A sketch is cached by the document before its ops, its ops and its stretch.
    const keys = read.sketch ? read.options.map((option) => sketchKey(record.document, option.ops, read.sceneId, read.from, read.to)) : null;
    const rendered = render(projectId, round, documents, keys).catch(() => {});
    return { ...round, rendered };
  }

  // A kino-built round: each sketch made on a fresh copy one after another (its song fetched,
  // its clips cut, its line set: deps.buildSketch), then all rendered. A sketch that cannot be
  // made shows its reason; the others still render.
  async function buildThenRender(record, round) {
    const projectId = record.document.id;
    const documents = [];
    const keys = [];
    for (const [index, option] of round.options.entries()) {
      try {
        const { document, basis, ...made } = await deps.buildSketch(record, round, option);
        documents[index] = document;
        keys[index] = sketchKey(basis ?? document, [], round.sceneId, round.from, round.to);
        await change(projectId, round.id, (found) => { Object.assign(found.options[index], made); });
      } catch (error) {
        documents[index] = null;
        const said = String(error?.message ?? error).split("\n")[0].slice(0, 200);
        await change(projectId, round.id, (found) => { found.options[index].error = said; });
      }
    }
    await render(projectId, round, documents, keys);
  }

  /**
   * After a sketch round's wait: the receipt lines when every sketch is done, else null and the
   * lines go to the inbox once they are (tellWhenReady), so they are told exactly once.
   */
  async function sketchReceipt(projectId, id) {
    let lines = null;
    await change(projectId, id, (found) => {
      if (found.status === "rendering") found.tellWhenReady = true;
      else lines = sketchLines(found);
    });
    return lines;
  }

  // One option after another (one render at a time), each clip shown as soon as it is ready.
  async function render(projectId, round, documents, keys = null) {
    const folder = folderOf(projectId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const keep = new Set((await agentState.read(projectId)).tries?.map((entry) => entry.id) ?? []);
    for (const name of await readdir(folder).catch(() => [])) if (!keep.has(name.split("-")[0])) await rm(path.join(folder, name), { force: true });
    let made = 0;
    for (const [index, option] of round.options.entries()) {
      if (!documents[index]) continue;
      try {
        const outputPath = path.join(folder, clipName(round.id, option.letter));
        let done = {};
        if (keys) done = await sketchClip(projectId, round, documents[index], keys[index], outputPath);
        else await deps.renderClip(documents[index], round.sceneId, round.from, round.to, outputPath, { sound: false });
        made += 1;
        await change(projectId, round.id, (found) => { Object.assign(found.options[index], done, { ready: true }); });
      } catch (error) {
        const said = String(error?.message ?? error).split("\n")[0].slice(0, 200);
        await change(projectId, round.id, (found) => { found.options[index].error = said; });
      }
    }
    await change(projectId, round.id, (found, state) => {
      if (found.status !== "rendering") return;
      if (made >= 2) {
        found.status = "waiting";
        if (found.tellWhenReady) state.inbox.push({ kind: "try", text: [`sketches ${found.id} are ready on the dashboard:`, ...sketchLines(found)].join("\n") });
        return;
      }
      found.status = "failed";
      found.error = "fewer than 2 options could be rendered";
      state.inbox.push({ kind: "try", text: `try ${found.id} "${found.question}" could not be shown: ${found.options.map((option) => option.error).filter(Boolean)[0] ?? found.error}.` });
    });
  }

  // One sketch: from the cache when its key was rendered before, else rendered with its sound
  // (timed) and measured, then kept. Answers what the option keeps: renderSeconds, cached, facts.
  async function sketchClip(projectId, round, document, key, outputPath) {
    const cache = cacheOf(projectId);
    const saved = await cache.take(key, outputPath);
    if (saved) return { cached: true, renderSeconds: 0, facts: saved.facts, key };
    const began = now();
    await deps.renderClip(document, round.sceneId, round.from, round.to, outputPath, { sound: true });
    const renderSeconds = Math.round((now() - began) / 10) / 100;
    const facts = await deps.measureSketch(document, round.sceneId, round.from, round.to, outputPath);
    await cache.keep(key, outputPath, { facts, renderSeconds }).catch(() => {});
    return { cached: false, renderSeconds, facts, key };
  }

  /** The person's answer to round `id`: a letter, "none" or "skip", with optional words. */
  async function answer(projectId, { id, pick, note = "" }) {
    if (![...TRY_LETTERS, ...TRY_ANSWERS].includes(pick)) throw new Error(`pick is a letter (A to D), none or skip.`);
    let refusal = null;
    const round = await change(projectId, id, (found, state) => {
      if (found.status !== "waiting") { refusal = `try ${id} is ${found.status}, not waiting.`; return; }
      const option = found.options.find((entry) => entry.letter === pick);
      if (TRY_LETTERS.includes(pick) && !option?.ready) { refusal = `try ${id} has no option ${pick} to pick.`; return; }
      found.pick = pick;
      found.words = words(note, NOTE_MOST) || null;
      found.status = pick === "none" ? "none" : pick === "skip" ? "skipped" : "picked";
      found.answeredAt = new Date(now()).toISOString();
      // A picked sketch is the person's treatment pick, saved as their typed pick is.
      if (found.sketch && option?.treatment && deps.pickTreatment) {
        try {
          // The treatments may have been saved again since the sketch was made: the letter then names another idea.
          const current = option.idea ? deps.briefOf?.(state)?.treatments : null;
          if (current && treatmentOf(current, option.treatment)?.idea !== option.idea) throw new Error(`the treatments were saved again after ${found.id}, so ${option.treatment} now names another idea`);
          deps.pickTreatment(state, found, option);
          found.treatmentSaved = true;
          // The sketch's song, font and line go with the pick (sketches.mjs pickedSketch reads them).
          const carried = sketchCarry(found, option);
          if (carried && state.brief?.treatments?.picked) state.brief.treatments.picked.sketch = carried;
        }
        catch (error) { found.treatmentError = String(error?.message ?? error).split("\n")[0].slice(0, 160); }
      }
      state.turnBreak = true;
      state.inbox.push({ kind: "try", text: answerText(found) });
    });
    if (!round) throw new Error(`No try round ${id}.`);
    if (refusal) throw new Error(refusal);
    return round;
  }

  /** The file of one option's clip, or null. */
  function file(projectId, name) {
    return /^T\d+-[A-D]\.mp4$/.test(name) ? path.join(folderOf(projectId), name) : null;
  }

  return { start, answer, file, sketchReceipt };
}
