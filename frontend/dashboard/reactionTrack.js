// The reaction track's browser side: while the stage plays, what the person does is kept as a
// few entries (backend/agent/reactions.mjs saves and prints them for the agent).
//
// Data flow: Dashboard.jsx tells the track when playing starts (play), each display frame's time
// (tick), and when it stops (stop) → the track turns that into entries: the ranges played, a jump
// back over a part ("again"), a jump forward over a part ("skip"), a pause of 1 s or more, and a
// play-through each time the scene's loop wraps after most of it played → take() hands the batch
// to one notes {action:"reactions"} call when playing stops or the window hides.
//
// Every seek in the dashboard (the scrub bar, the timeline, the ruler, the keys, a note's jump)
// stops playing first and plays again from the new time, so the track compares where playing
// stopped with where it starts again, whatever moved the time. A chain of jumps whose landings
// played less than CHAIN_WATCH seconds is one jump, from the first start to the last landing
// (more than half of jump-backs only fix the jump before). The scene's own loop wrapping around
// is never a look-again. Nothing here knows about React.

// A landing played less than this long is part of the next jump's chain.
export const CHAIN_WATCH = 1;
// A stop and a start this close in scene time are the same place (no jump).
const SAME_PLACE = 0.15;
// A pause at least this long is kept.
export const MIN_PAUSE = 1;
// A loop wrap counts as a play-through when this share of the scene played since the last one.
const THROUGH_SHARE = 0.9;
// A mark made while playing starts this long before the click (raters lag the moment by 1 to 6 s).
export const MARK_LAG = 3;
// At most this many entries wait to be sent (the oldest played ranges go first).
const MAX_WAITING = 120;

const round = (value) => Math.round(value * 100) / 100;
const defaultWall = () => Date.now() / 1000;

/** Total length of a list of [a, b] ranges, overlaps counted once. */
export function coveredLength(ranges) {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of sorted) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

export function createReactionTrack({ wall = defaultWall, rev = () => null, makeId = (n) => `m${Date.now().toString(36)}${n}` } = {}) {
  let waiting = [];
  // While playing: {scene, duration, from, last}.
  let run = null;
  // The ranges played since the last play-through, by scene.
  let pass = new Map();
  // The last stop: {scene, time, wall, watched (seconds the run before it played)}.
  let stopped = null;
  // A jump not yet kept, while its landing may still be part of a chain: {scene, from, to}.
  let jump = null;
  let marks = 0;

  const push = (entry) => {
    waiting.push({ ...entry, rev: rev() });
    if (waiting.length > MAX_WAITING) {
      const index = waiting.findIndex((item) => item.kind === "played");
      waiting.splice(index >= 0 ? index : 0, 1);
    }
  };

  function keepJump() {
    if (!jump) return;
    const { scene, from, to } = jump;
    jump = null;
    if (Math.abs(to - from) < SAME_PLACE) return;
    push(to < from ? { kind: "again", scene, a: round(to), b: round(from) } : { kind: "skip", scene, a: round(from), b: round(to) });
  }

  function played(scene, a, b) {
    if (b - a < 0.05) return;
    push({ kind: "played", scene, a: round(a), b: round(b) });
    const list = pass.get(scene) ?? [];
    list.push([a, b]);
    pass.set(scene, list);
  }

  // Closes the run at `time` (wrapped scene time) and returns how long it played.
  function closeRun(time) {
    if (!run) return 0;
    const end = Math.max(run.from, Math.min(time, run.duration));
    played(run.scene, run.from, end);
    const watched = run.watched + (end - run.from);
    run = null;
    return watched;
  }

  return {
    /** Playing starts in `scene` (its length `duration` seconds) at `time`. */
    play(scene, time, duration) {
      const now = wall();
      if (stopped && stopped.scene === scene) {
        if (Math.abs(time - stopped.time) < SAME_PLACE) {
          keepJump();
          if (now - stopped.wall >= MIN_PAUSE) push({ kind: "pause", scene, t: round(stopped.time), s: round(now - stopped.wall) });
        } else if (jump && jump.scene === scene && stopped.watched < CHAIN_WATCH) {
          jump.to = time;
        } else {
          keepJump();
          jump = { scene, from: stopped.time, to: time };
        }
      } else keepJump();
      stopped = null;
      run = { scene, duration: Math.max(1e-3, duration), from: time, last: time, watched: 0 };
    },

    /** The time on screen while playing; a wrap at the scene's end may count a play-through. */
    tick(scene, time, duration = run?.duration) {
      if (!run) return;
      // Another scene while playing: its run starts there, without a jump.
      if (scene !== run.scene) {
        closeRun(run.last);
        keepJump();
        run = { scene, duration: Math.max(1e-3, duration), from: time, last: time, watched: 0 };
        return;
      }
      if (time < run.last - 0.5) {
        // The scene's loop wrapped (playing never jumps back otherwise): not a look-again.
        played(run.scene, run.from, run.duration);
        const share = coveredLength(pass.get(run.scene) ?? []) / run.duration;
        if (share >= THROUGH_SHARE) push({ kind: "through", scene: run.scene });
        pass.set(run.scene, []);
        run = { ...run, watched: run.watched + (run.duration - run.from), from: time, last: time };
        return;
      }
      run.last = time;
      // A landing that plays long enough ends its chain.
      if (jump && run.watched + (time - run.from) >= CHAIN_WATCH) keepJump();
    },

    /** Playing stops at `time`. */
    stop(time) {
      if (!run) return;
      const scene = run.scene;
      const watched = closeRun(time);
      stopped = { scene, time, wall: wall(), watched };
    },

    /** A good or bad mark at `time`: a range from up to MARK_LAG s before while playing, else the time. */
    mark(kind, scene, time, playing) {
      marks += 1;
      const entry = { id: makeId(marks), kind, scene, a: round(playing ? Math.max(0, time - MARK_LAG) : time), b: round(time), playing: Boolean(playing) };
      push(entry);
      return { ...entry, rev: rev() };
    },

    /** Drops a mark not sent yet; true when it was still waiting. */
    unmark(id) {
      const before = waiting.length;
      waiting = waiting.filter((entry) => entry.id !== id);
      return waiting.length < before;
    },

    /**
     * The entries to send now. A jump whose landing played less than CHAIN_WATCH s may still grow
     * into a chain, so it waits for the next play, unless `final` (the window hides).
     */
    take({ final = false } = {}) {
      if (final) keepJump();
      const batch = waiting;
      waiting = [];
      return batch;
    },

    get pending() { return waiting.length + (jump ? 1 : 0); },
  };
}
