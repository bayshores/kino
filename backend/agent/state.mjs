// The agent's side of a project, saved beside the project store: short codes, the plan, the
// brief from the chat (brief.mjs), the stops and their answers (stops.mjs), the approved
// storyboards (board.mjs), notes for the agent, turns (groups of agent calls), what the agent
// last looked at, and an event log the dashboard reads. One JSON file per project under
// <data>/agent/, written atomically (under <data>/agent/projects/); one event log per project as
// JSON lines.
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyCodes } from "./refs.mjs";

// A new turn starts when the agent has been quiet this long, or after you act in the dashboard.
export const TURN_GAP_MS = 2 * 60 * 1000;
const MAX_TURNS = 200;
const MAX_NOTES = 500;
const MAX_STOPS = 100;
const MAX_BOARDS = 20;
const MAX_EVENTS_KEPT_IN_MEMORY = 500;

export function emptyAgentState() {
  return {
    version: 1,
    codes: emptyCodes(),
    plan: { steps: [], updatedAt: null },
    // The brief the agent saved from the chat (brief.mjs); null until it saves one.
    brief: null,
    // The project's deck of techniques (engine/deck.js, backend/agent/deck.mjs); null until dealt.
    deck: null,
    // The scene length (seconds) kino gave a project made without a duration, or null: while the
    // scene keeps it, the brief does not count the video as short (brief.mjs questionLimit).
    defaultLength: null,
    // The stops asked for this video (stops.mjs): one round per ask, the next round's number,
    // the agent's last full check (a stop shows only checked work) and "stop asking" from the chat.
    stops: [],
    nextStop: 1,
    checked: null,
    stopAsking: null,
    // The approved storyboards (board.mjs): a frozen copy of the board for each approval, what
    // lapsed it and the small changes logged since. An approval adds an entry, never changes one.
    boards: [],
    // The board's open items the person left to the agent ("your call": {open, words, at}).
    leftToAgent: null,
    notes: [],
    // Agent edits refused because they would remove a layer an always note keeps (S1, S2, ...),
    // until the person answers keep or let: {id, noteId, layers, summary, at, agent?}.
    stopped: [],
    nextStopped: 1,
    turns: [],
    nextTurn: 1,
    // Minutes and kino calls per step of the video's making (step-log.mjs); null until a call is logged.
    stepLog: null,
    nextNote: 1,
    looks: {},
    inbox: [],
  };
}

const fileName = (projectId) => `${encodeURIComponent(projectId)}.json`;

export function createAgentStateStore(dataRoot) {
  const directory = path.join(dataRoot, "agent", "projects");
  const cache = new Map();
  const queues = new Map();
  const recentEvents = new Map();
  const listeners = new Set();
  // How many times each project's agent state was deleted (remove). A file read that began
  // before a delete finished is not kept in memory: it may hold what the delete removed.
  const removals = new Map();

  async function load(projectId) {
    if (cache.has(projectId)) return cache.get(projectId);
    const removed = removals.get(projectId) ?? 0;
    let state;
    try {
      state = { ...emptyAgentState(), ...JSON.parse(await readFile(path.join(directory, fileName(projectId)), "utf8")) };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Could not read the agent state of project ${projectId}: ${error.message}`, { cause: error });
      state = emptyAgentState();
    }
    // An update saved (or another read kept) a state while this one read the file: it is as new.
    if (cache.has(projectId)) return cache.get(projectId);
    if ((removals.get(projectId) ?? 0) === removed) cache.set(projectId, state);
    return state;
  }

  async function save(projectId, state) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, fileName(projectId));
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, target);
  }

  // Runs `change(state)` for one project at a time, then saves. Returns what `change` returns.
  function update(projectId, change) {
    const previous = queues.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const state = await load(projectId);
      const draft = structuredClone(state);
      const result = await change(draft);
      draft.turns = draft.turns.slice(-MAX_TURNS);
      draft.notes = draft.notes.slice(-MAX_NOTES);
      draft.stopped = (draft.stopped ?? []).slice(-MAX_STOPS);
      draft.stops = (draft.stops ?? []).slice(-MAX_STOPS);
      draft.boards = (draft.boards ?? []).slice(-MAX_BOARDS);
      await save(projectId, draft);
      cache.set(projectId, draft);
      return result;
    });
    queues.set(projectId, run);
    return run;
  }

  async function read(projectId) {
    return structuredClone(await load(projectId));
  }

  // Events are what the dashboard shows: every agent call and its answer size, notes, reverts.
  async function record(projectId, event) {
    const entry = { at: new Date().toISOString(), projectId, ...event };
    // After a restart, read the saved events first: otherwise the list in memory would start
    // with this one and the older ones (who made each turn) would never be read back. Calls that
    // come while the file is read all wait for the same read, so they go on in their order.
    const reading = loadEvents(projectId);
    if (reading) await reading;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(path.join(directory, `${encodeURIComponent(projectId)}.events.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const list = recentEvents.get(projectId) ?? [];
    list.push(entry);
    recentEvents.set(projectId, list.slice(-MAX_EVENTS_KEPT_IN_MEMORY));
    for (const listener of listeners) listener(entry);
    return entry;
  }

  // The one read of a project's saved events in progress, shared by the calls that wait for it.
  const loading = new Map();
  function loadEvents(projectId) {
    if (recentEvents.has(projectId)) return null;
    if (!loading.has(projectId)) loading.set(projectId, events(projectId).finally(() => loading.delete(projectId)));
    return loading.get(projectId);
  }

  async function events(projectId, { limit = 100 } = {}) {
    if (!recentEvents.has(projectId)) {
      const removed = removals.get(projectId) ?? 0;
      let list;
      try {
        const lines = (await readFile(path.join(directory, `${encodeURIComponent(projectId)}.events.jsonl`), "utf8")).trim().split("\n");
        list = lines.filter(Boolean).slice(-MAX_EVENTS_KEPT_IN_MEMORY).map((line) => JSON.parse(line));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        list = [];
      }
      if ((removals.get(projectId) ?? 0) === removed) recentEvents.set(projectId, list);
      return list.slice(-limit);
    }
    return recentEvents.get(projectId).slice(-limit);
  }

  function onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Deletes a project's agent state and event log (its brief, plan, notes and turns), for a
  // project deleted forever, so a new project with the same id starts empty. It waits for the
  // project's queued updates, so none of them writes the file again afterwards. The files go
  // first and the memory after, and a read that was still reading the old file is not kept
  // (removals), so no later update writes the deleted brief back.
  function remove(projectId) {
    const previous = queues.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await rm(path.join(directory, fileName(projectId)), { force: true });
      await rm(path.join(directory, `${encodeURIComponent(projectId)}.events.jsonl`), { force: true });
      removals.set(projectId, (removals.get(projectId) ?? 0) + 1);
      cache.delete(projectId);
      recentEvents.delete(projectId);
    });
    queues.set(projectId, run);
    return run;
  }

  /**
   * The decks of this machine's other projects, newest deal first (at most `count`): what each
   * was dealt and what its video used ([{ projectId, cards, used, dealtAt, media?, story? }]).
   * The deck reads them to steer away from the last few projects (novelty), except kin ones
   * (media or story shared; a deck dealt before kino saved them has neither). A file that
   * cannot be read is left out.
   */
  async function recentDecks(exceptId, count = 3) {
    let names;
    try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const decks = [];
    for (const name of names) {
      const projectId = decodeURIComponent(name.slice(0, -".json".length));
      if (projectId === exceptId) continue;
      let deck;
      try { deck = cache.get(projectId)?.deck ?? JSON.parse(await readFile(path.join(directory, name), "utf8")).deck; }
      catch { continue; }
      if (deck?.dealtAt) decks.push({ projectId, cards: [...(deck.cards ?? []).map((card) => card.tag), ...(deck.setPiece ? [deck.setPiece.name] : [])], used: deck.used ?? [], dealtAt: deck.dealtAt,
        ...(deck.media ? { media: deck.media } : {}), ...(deck.story ? { story: deck.story } : {}) });
    }
    return decks.sort((a, b) => b.dealtAt.localeCompare(a.dealtAt)).slice(0, count);
  }

  return { read, update, record, events, onEvent, remove, recentDecks };
}

// Whether the agent's turn is over: its next call starts a new one (after a quiet gap, after
// you did something in the dashboard, or after its last turn was reverted).
export function turnOver(state, now = Date.now()) {
  const last = state.turns.at(-1);
  return !last || now - Date.parse(last.lastCallAt) > TURN_GAP_MS || Boolean(state.turnBreak) || Boolean(last.reverted);
}

// The turn an agent call belongs to: the open turn, or a new one after a quiet gap or after
// you did something in the dashboard (state.turnBreak). Mutates state; returns the turn.
export function currentTurn(state, now = Date.now()) {
  const last = state.turns.at(-1);
  if (turnOver(state, now)) {
    const turn = { id: `T${state.nextTurn++}`, startedAt: new Date(now).toISOString(), lastCallAt: new Date(now).toISOString(), calls: 0, edits: [] };
    state.turns.push(turn);
    delete state.turnBreak;
    return turn;
  }
  last.lastCallAt = new Date(now).toISOString();
  return last;
}
