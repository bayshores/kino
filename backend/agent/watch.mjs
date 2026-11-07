// `kino watch`: the person's new notes, delivered to an agent that is not connected through a
// Claude Code channel (any terminal agent can run it in the background and read its lines).
// Notes left close together arrive as one batch: a batch waits until no new note has come for
// `settle` seconds (default 8), and never longer than 30 s after its first note, so several
// notes written in a row reach the agent together. `kino watch pending` lists the notes still
// new (nobody has read them) and exits 2 when there are any, for an agent's stop hook.

const MAX_WAIT_MS = 30_000;

const clip = (text, size = 200) => (text.length > size ? `${text.slice(0, size - 1)}…` : text);

/** One note as a short line: N5 @12.3s "text". */
export function noteText(note) {
  const at = note.time != null ? ` @${Math.round(note.time * 10) / 10}s` : "";
  return `${note.id}${note.urgent ? " (urgent)" : ""}${at} "${clip(String(note.text ?? "").replace(/\s+/g, " ").trim())}"`;
}

/** A batch of one project's notes as one line, with what to do next. */
export function batchLine(projectId, notes) {
  const count = notes.length === 1 ? "1 new note" : `${notes.length} new notes`;
  return `kino: ${count} on ${projectId}: ${notes.map(noteText).join(" · ")} · read them with notes {action:"list", project:"${projectId}"}, act, then reply to each`;
}

/**
 * Collects notes and hands them over in batches (onBatch(projectId, notes)). A note seen once is
 * never handed over again. Timers come in for the tests.
 */
export function createNoteBatcher({ onBatch, settleMs = 8000, maxMs = MAX_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  const seen = new Set();
  const waiting = new Map(); // project -> {notes, firstAt, timer}
  const flush = (projectId) => {
    const batch = waiting.get(projectId);
    if (!batch) return;
    clearTimer(batch.timer);
    waiting.delete(projectId);
    onBatch(projectId, batch.notes);
  };
  return {
    add(projectId, note) {
      const key = `${projectId}/${note.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const batch = waiting.get(projectId) ?? { notes: [], firstAt: now(), timer: null };
      batch.notes.push(note);
      waiting.set(projectId, batch);
      clearTimer(batch.timer);
      const left = Math.max(0, Math.min(settleMs, batch.firstAt + maxMs - now()));
      batch.timer = setTimer(() => flush(projectId), left);
      batch.timer?.unref?.();
      return true;
    },
    flushAll() { for (const projectId of [...waiting.keys()]) flush(projectId); },
  };
}

/** The open project's notes nobody has read yet (or one project's, by id). */
export async function pendingNotes(client, project) {
  const snapshot = await client.read(`snapshot${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  const notes = (snapshot?.agent?.notes ?? []).filter((note) => note.status === "new");
  return { projectId: snapshot?.projectId ?? project ?? null, notes };
}

/**
 * Prints each batch of new notes as one line (print), until signal aborts. Starts with the notes
 * already waiting in the open project (or `project`), then follows the dashboard's event stream,
 * reconnecting after a drop or an app restart. Each delivered note is marked sent, so the
 * dashboard shows that it reached the agent.
 */
export async function watchNotes(client, { project, settleMs, signal, print = console.log } = {}) {
  const batcher = createNoteBatcher({
    settleMs,
    onBatch: (projectId, notes) => {
      print(batchLine(projectId, notes));
      for (const note of notes) client.post("channel-sent", { project: projectId, note: note.id }).catch(() => {});
    },
  });
  const waiting = await pendingNotes(client, project).catch(() => null);
  if (waiting) for (const note of waiting.notes) batcher.add(waiting.projectId, note);
  while (!signal?.aborted) {
    try {
      await client.stream((event) => {
        const note = event.note;
        if (event.type !== "note" || !note || note.status !== "new" || (note.from && note.from !== "you")) return;
        if (project && event.projectId !== project) return;
        batcher.add(event.projectId, note);
      }, { signal });
    } catch {
      if (signal?.aborted) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000).unref?.());
  }
  batcher.flushAll();
}
