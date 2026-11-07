// Who is working right now, and what they have not looked at yet, for the dashboard's live view
// (milestone LIVE). This is not backend/presence.mjs, which tracks people's cursors in an open
// editor: everything here comes from real agent calls (service.mjs call()).
//
// - Each agent (one MCP server process, or the kino command line) is told apart by the
//   x-kino-session header its thin client adds by itself (client.mjs); agents send nothing new.
//   A session's first real call gives it the next name and color, as {id:"a1", name:"Nova",
//   color, kind}. The session itself never leaves the server. Names start over when the server
//   restarts; a log row keeps the name it was recorded with. A call without a session (an older
//   client) is "agent", in the first color. What is saved with an agent's id (an approval, a
//   stop round) also keeps `boot`, this server run's id, so the dashboard never matches it to
//   the agent that has that id after a restart.
// - "Building" marks: the layers an agent saved in the current turn that no look has covered
//   since. They are kept in memory only, never saved and never rendered. A look by any agent
//   that covers a layer clears it, when the revision it drew had that save, and a turn that ends
//   clears them all ({type:"building"} tells the dashboard when no presence does).
// - Every call is published twice on the dashboard's event stream as {type:"presence"}: before
//   its handler runs (phase "start") and after its call event (phase "done"). Each presence
//   says how many of that agent's calls still run (`running`), as calls can run side by side.
import { animationTreeEntries } from "../../engine/animationTree.js";
import { documentChanges } from "../../engine/documentChanges.js";

export const NAMES = Object.freeze(["Nova", "Juno", "Atlas", "Iris", "Orion", "Vega", "Lyra", "Sol", "Rhea", "Kepler", "Tess", "Mira"]);
// Teal, sky, lime, pink and cream: each reads at 4.5:1 or more on the dashboard's dark
// backgrounds, none is purple, and each stays clear of the warning and error colors
// (backend/agent-live.test.mjs checks all three).
export const PALETTE = Object.freeze(["#42c0b6", "#6cb6ff", "#a8d95b", "#f28cb8", "#efe3c2"]);
const SESSION = /^[A-Za-z0-9_-]{3,32}$/;
const SESSIONS_KEPT = 1000;
const LATEST_KEPT = 64;
const LATEST_SHOWN = 12;
const BUILDING_KEPT = 200;
const CHECKED_KEPT = 16;

/**
 * Whether `agent` is told apart from the others of its kind (it sent a session). An agent without
 * one ("legacy-<kind>") is matched by its kind, as a wait saved without an agent is.
 */
export const knownAgent = (agent) => typeof agent?.id === "string" && !agent.id.startsWith("legacy-");

/** The x-kino-session header when it is valid (3 to 32 of A-Z a-z 0-9 _ -), else null. */
export const validSession = (value) => (typeof value === "string" && SESSION.test(value) ? value : null);

/**
 * The kind of agent, from the MCP client's own name (clientInfo.name, such as "claude-code") or
 * "cli". It is untrusted text: control, bidi and zero-width characters go, then everything but
 * letters, digits, space, dot, underscore and dash; at most 32 characters; "agent" when empty.
 */
export function cleanKind(text) {
  const kept = String(text ?? "").replace(/\p{C}/gu, "").replace(/[^A-Za-z0-9 ._-]/g, "").replace(/ +/g, " ").trim();
  return kept.slice(0, 32).trim() || "agent";
}

/**
 * When a layer is on screen, as [start, end] in scene seconds: from the start of its first enabled
 * entrance ("in") animation, else 0, to the end of its last enabled exit ("out"), else the end
 * of the scene.
 */
export function layerWindow(layer, scene) {
  const duration = Number(scene?.duration) || 0;
  let entries = [];
  try { entries = animationTreeEntries(layer?.animations ?? [], { enabledOnly: true, groups: false }); } catch { /* too deep: the whole scene */ }
  const ins = entries.filter(({ animation }) => animation?.kind === "in");
  const outs = entries.filter(({ animation }) => animation?.kind === "out");
  const start = ins.length ? Math.min(...ins.map(({ animation }) => Number(animation.start) || 0)) : 0;
  const end = outs.length ? Math.max(...outs.map(({ animation }) => (Number(animation.start) || 0) + (Number(animation.duration) || 0))) : duration;
  return [start, end];
}

/**
 * The layers of `scene` a look covered. `cover` is {layerIds} (zoom, strip or source on a layer),
 * {time} (a frame: the layers on screen then) or {range: [from, to]} (a sheet and the like: the
 * layers on screen at any time in it).
 */
export function coveredLayers(scene, cover) {
  const covered = new Set();
  if (!scene || !cover) return covered;
  for (const id of cover.layerIds ?? []) covered.add(id);
  for (const layer of scene.layers ?? []) {
    const [start, end] = layerWindow(layer, scene);
    if (Number.isFinite(cover.time) && start <= cover.time && cover.time <= end) covered.add(layer.id);
    if (Array.isArray(cover.range) && start <= cover.range[1] && end >= cover.range[0]) covered.add(layer.id);
  }
  return covered;
}

/** Every layer a save created or changed (itself or one of its animations), as {sceneId, layerId}. */
export function touchedLayers(before, after) {
  if (!after?.scenes?.length) return [];
  const changes = documentChanges(before, after);
  const touched = new Set([...changes.created, ...changes.changed]);
  const found = [];
  for (const scene of after.scenes) {
    for (const layer of scene.layers ?? []) {
      let changedAnimation = false;
      try { changedAnimation = animationTreeEntries(layer.animations ?? []).some(({ stored }) => stored && touched.has(stored.id)); } catch { /* skipped */ }
      if (touched.has(layer.id) || changedAnimation) found.push({ sceneId: scene.id, layerId: layer.id });
    }
  }
  return found;
}

/**
 * The live view's memory. `publish(event)` is the dashboard's (dashboard.mjs), which numbers the
 * event and stamps its time.
 */
export function createLiveAgents({ now = Date.now, publish = () => null, boot = null, known = () => null, takenNames = () => [] } = {}) {
  const sessions = new Map();
  const latest = new Map();
  const building = new Map();
  // Each project's last looks: what each covered ({sceneId, ids}) in the revision it drew.
  const checked = new Map();
  const turns = new Map();
  // Each agent's calls that started and are not done yet.
  const running = new Map();
  let calls = 0;

  /** The agent making this call: {id, name, color, kind}. Only called for a real call. */
  // An agent kino started (the crew, crew.mjs) has its own id, name and color for its session
  // (`known`). Other sessions get the next name that no started agent uses now (`takenNames`).
  let nextName = 0;
  function identify({ session, kind } = {}) {
    const agentKind = cleanKind(kind);
    const key = validSession(session);
    const crew = key ? known(key) : null;
    if (crew) return { ...crew };
    if (!key || (!sessions.has(key) && sessions.size >= SESSIONS_KEPT)) return { id: `legacy-${agentKind}`, name: "agent", color: PALETTE[0], kind: agentKind };
    if (!sessions.has(key)) {
      const index = sessions.size;
      const taken = new Set(takenNames());
      let name;
      for (let tries = 0; tries < 1000; tries += 1) {
        const round = Math.floor(nextName / NAMES.length);
        name = `${NAMES[nextName % NAMES.length]}${round ? ` ${round + 1}` : ""}`;
        nextName += 1;
        if (!taken.has(name)) break;
      }
      sessions.set(key, { id: `a${index + 1}`, name, color: PALETTE[index % PALETTE.length] });
    }
    return { ...sessions.get(key), kind: agentKind };
  }

  const buildingOf = (projectId, document) => {
    const list = building.get(projectId) ?? [];
    if (!document?.scenes) return list.map((entry) => ({ ...entry }));
    const alive = new Set(document.scenes.flatMap((scene) => (scene.layers ?? []).map((layer) => layer.id)));
    return list.filter((entry) => alive.has(entry.layerId)).map((entry) => ({ ...entry }));
  };

  /**
   * Publishes one presence and keeps it as the agent's latest. It says how many of the agent's
   * calls still run after it (`running`). Returns the published event.
   */
  function show(projectId, presence) {
    const id = presence.agent.id;
    const open = running.get(id) ?? new Set();
    if (presence.phase === "start") open.add(presence.call);
    else open.delete(presence.call);
    running.delete(id);
    if (open.size) running.set(id, open);
    if (running.size > LATEST_KEPT) running.delete(running.keys().next().value);
    const shown = { ...presence, running: open.size };
    const event = publish({ type: "presence", projectId: projectId ?? null, presence: shown });
    latest.delete(id);
    // seq (the event's number) orders two presences published in the same millisecond.
    latest.set(id, { ...shown, at: event?.at ?? new Date(now()).toISOString(), ...(Number.isSafeInteger(event?.seq) ? { seq: event.seq } : {}), projectId: projectId ?? null });
    if (latest.size > LATEST_KEPT) latest.delete(latest.keys().next().value);
    return event;
  }

  /** Tells the dashboard the project's building marks when no presence does (a turn ended). */
  function showBuilding(projectId, document) {
    if (!projectId) return null;
    return publish({ type: "building", projectId, building: buildingOf(projectId, document) });
  }

  /** Each agent's latest presence in this project, newest first (at most 12). */
  function latestIn(projectId) {
    return [...latest.values()].reverse().filter((entry) => entry.projectId === projectId).slice(0, LATEST_SHOWN)
      .map(({ projectId: _project, ...presence }) => presence);
  }

  /** The project's turn as the last call saw it. A new turn clears every building mark. */
  function noteTurn(projectId, turn) {
    if (!projectId || !turn) return;
    if (turns.has(projectId) && turns.get(projectId) !== turn) building.delete(projectId);
    turns.set(projectId, turn);
  }

  /** The turn ended (a quiet gap, your undo or note): its marks go. True when there were any. */
  function endTurn(projectId) {
    turns.delete(projectId);
    return building.delete(projectId);
  }

  /**
   * An agent saved `layers` ({sceneId, layerId}) in revision `rev`; deleted layers drop out. A
   * layer that a look of revision `rev` or later already covered is not marked: that look finished
   * while the save's call was still finishing (its marks come after its call event).
   */
  function wrote(projectId, document, { agentId, layers, rev = null }) {
    if (!projectId) return;
    const marked = new Set(layers.map((entry) => entry.layerId));
    const kept = buildingOf(projectId, document).filter((entry) => !marked.has(entry.layerId));
    const seen = rev == null ? [] : (checked.get(projectId) ?? []).filter((look) => look.rev >= rev);
    const unseen = layers.filter(({ sceneId, layerId }) => !seen.some((look) => look.sceneId === sceneId && look.ids.has(layerId)));
    const at = new Date(now()).toISOString();
    building.set(projectId, [...kept, ...unseen.map(({ sceneId, layerId }) => ({ sceneId, layerId, agentId, at, rev }))].slice(-BUILDING_KEPT));
  }

  /**
   * A look drew `document` (revision `rev`) and covered `covers` ([{sceneId, layerIds?, time?,
   * range?}]) of it: those layers are checked. A save the drawn revision did not have yet (another
   * agent's, or a parallel call's) stays building.
   */
  function looked(projectId, covers, { document, rev = null } = {}) {
    const found = covers.map((cover) => ({ sceneId: cover.sceneId, ids: coveredLayers(document?.scenes?.find((scene) => scene.id === cover.sceneId), cover), rev }));
    if (rev != null) checked.set(projectId, [...(checked.get(projectId) ?? []), ...found].slice(-CHECKED_KEPT));
    if (checked.size > LATEST_KEPT) checked.delete(checked.keys().next().value);
    if (!building.has(projectId)) return;
    const drawn = (entry) => entry.rev == null || rev == null || entry.rev <= rev;
    let list = building.get(projectId);
    for (const { sceneId, ids } of found) list = list.filter((entry) => entry.sceneId !== sceneId || !ids.has(entry.layerId) || !drawn(entry));
    building.set(projectId, list);
  }

  return {
    boot,
    identify,
    /** The names given to sessions in this server run. */
    names: () => [...sessions.values()].map((entry) => entry.name),
    nextCall: () => ++calls,
    show,
    showBuilding,
    latest: latestIn,
    building: buildingOf,
    turn: (projectId) => turns.get(projectId) ?? null,
    noteTurn,
    endTurn,
    wrote,
    looked,
  };
}
