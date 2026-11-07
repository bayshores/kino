// Transient collaboration view state. It has its own subscribers, so pointer
// traffic never enters document state, saves, recovery, or the editor panels.
export function createPresenceChannel({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let snapshot = { selfId: null, people: [], cursors: {}, selections: {} };
  let roster = { selfId: snapshot.selfId, people: snapshot.people };
  const listeners = new Set();
  const sceneSnapshots = new Map();
  let socket = null, projectId = null, ready = false, local = null, heartbeat = null, expiry = null;
  const outgoing = { cursor: null, selection: null };
  const timers = { cursor: null, selection: null };
  const sentAt = { cursor: -Infinity, selection: -Infinity };
  function update(next) {
    snapshot = { ...snapshot, ...next };
    if (Object.hasOwn(next, "people") || Object.hasOwn(next, "selfId")) roster = { selfId: snapshot.selfId, people: snapshot.people };
    for (const listener of listeners) listener();
  }
  function send(message) {
    if (!ready || socket?.readyState !== 1) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  function flush(kind) {
    clearTimer(timers[kind]); timers[kind] = null;
    if (!outgoing[kind] || !ready) return;
    const wait = 105 - (now() - sentAt[kind]);
    if (wait > 0) { timers[kind] = setTimer(() => flush(kind), wait); return; }
    if (send({ type: kind, ...outgoing[kind] })) {
      sentAt[kind] = now(); outgoing[kind] = null;
    }
  }
  function beat() {
    send({ type: "ping" });
    heartbeat = setTimer(beat, 15_000);
  }
  function expireCursors() {
    clearTimer(expiry); expiry = null;
    let next = Infinity, changed = false;
    const cursors = Object.fromEntries(Object.entries(snapshot.cursors).map(([id, cursor]) => {
      if (cursor.idle) return [id, cursor];
      const remaining = cursor.receivedAt + 10_000 - now();
      if (remaining <= 0) { changed = true; return [id, { ...cursor, idle: true }]; }
      next = Math.min(next, remaining);
      return [id, cursor];
    }));
    if (changed) update({ cursors });
    if (Number.isFinite(next)) expiry = setTimer(expireCursors, next);
  }
  function disconnect(expected = socket) {
    if (expected !== socket) return;
    socket = null; ready = false;
    clearTimer(heartbeat); clearTimer(expiry);
    heartbeat = expiry = null;
    for (const kind of ["cursor", "selection"]) {
      clearTimer(timers[kind]); timers[kind] = null; outgoing[kind] = null; sentAt[kind] = -Infinity;
    }
    sceneSnapshots.clear();
    update({ selfId: null, people: [], cursors: {}, selections: {} });
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    getRoster: () => roster,
    getSceneSnapshot(sceneId) {
      const cached = sceneSnapshots.get(sceneId);
      if (cached?.source === snapshot) return cached.value;
      const inScene = (entries) => Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.sceneId === sceneId));
      const value = { people: snapshot.people.filter((person) => person.sceneId === sceneId),
        cursors: inScene(snapshot.cursors), selections: inScene(snapshot.selections) };
      const sameEntries = (left, right) => Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((id) => left[id] === right[id]);
      const previous = cached?.value;
      if (previous && sameEntries(previous.cursors, value.cursors)) value.cursors = previous.cursors;
      if (previous && sameEntries(previous.selections, value.selections)) value.selections = previous.selections;
      const samePeople = previous && previous.people.length === value.people.length && previous.people.every((person, index) => {
          const other = value.people[index];
          return person.id === other.id && person.name === other.name && person.color === other.color && person.sceneId === other.sceneId;
        });
      if (samePeople) value.people = previous.people;
      const same = previous && previous.cursors === value.cursors && previous.selections === value.selections && samePeople;
      const result = same ? previous : value;
      sceneSnapshots.set(sceneId, { source: snapshot, value: result });
      return result;
    },
    connect(nextSocket, nextProjectId) {
      disconnect(); socket = nextSocket; projectId = nextProjectId;
      heartbeat = setTimer(beat, 15_000);
    },
    disconnect,
    receive(message) {
      if (message.type === "presence") {
        const people = message.people ?? [];
        const keep = (entry) => people.some((person) => person.id === entry.id && person.sceneId === entry.sceneId);
        update({ selfId: message.selfId, people,
          cursors: Object.fromEntries(Object.entries(snapshot.cursors).filter(([, entry]) => keep(entry))),
          selections: Object.fromEntries(Object.entries(snapshot.selections).filter(([, entry]) => keep(entry))),
        });
        if (!ready) {
          ready = true;
          if (local?.projectId === projectId) { outgoing.selection = local.selection; flush("selection"); }
        }
        return true;
      }
      if (message.type !== "cursor" && message.type !== "selection") return false;
      const person = snapshot.people.find((entry) => entry.id === message.id);
      if (!person || person.id === snapshot.selfId) return true;
      if (message.type === "cursor" && message.sceneId !== person.sceneId) return true;
      // Metadata comes from the latest server roster, including a renamed peer.
      const entry = { ...message, name: person.name, color: person.color };
      if (message.type === "selection") update({ selections: { ...snapshot.selections, [entry.id]: entry } });
      else {
        update({ cursors: { ...snapshot.cursors, [entry.id]: { ...entry, receivedAt: now(), idle: false } } });
        expireCursors();
      }
      return true;
    },
    select(id, selection) {
      if (typeof id !== "string" || !id) return;
      const next = { sceneId: selection?.sceneId ?? null, layerIds: [...(selection?.layerIds ?? [])].slice(0, 200),
        ...(selection?.componentPath ? { componentPath: selection.componentPath } : {}) };
      if (local?.projectId === id && JSON.stringify(local.selection) === JSON.stringify(next)) return;
      local = { projectId: id, selection: next };
      if (id === projectId) { outgoing.selection = next; flush("selection"); }
    },
    documentSaved(id) {
      // A just-created layer or scene may have been selected before its save
      // reached the server's ID validator. Publish it once that save is known.
      if (local && local.projectId === id && id === projectId) { outgoing.selection = local.selection; flush("selection"); }
    },
    cursor(x, y, sceneId) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      outgoing.cursor = { x, y, sceneId }; flush("cursor");
    },
  };
}
