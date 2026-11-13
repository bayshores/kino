// The song step: what `next:` says from "no song yet" to a song in the project. A run searched
// songs once, got a list, and `next:` moved on to the build, so it took a bundled track: every
// stage is a call here (find, wait for the measures, import the best fit). Pure functions.

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// The sound the agent writes for explore, in music words. The brief's look and sound line is only
// a hint inside it: it mixes picture words in ("dark, bold type"), and a keyword search on such
// words finds stock uploads, where explore finds released songs by lane.
export const songWant = (brief) => {
  const hint = oneLine(brief?.fields?.look_sound?.text).replace(/[<>]/g, "").slice(0, 60);
  return `<this video's sound in music words: lane, mood, instruments${hint ? ` (the brief says: ${hint})` : ""}>`;
};

/** The real-song finder's call: released songs by lane, scored by the sound the agent writes. */
export const songCall = (brief) => ({ tool: "library", input: { topic: "soundtrack", explore: { want: songWant(brief) } } });

export const SONG_LIST_CALL = Object.freeze({ tool: "library", input: { topic: "soundtrack" } });
export const SONG_PICK_STEP = "pick the song: list the candidates ranked, import the best fit";

// Measured songs that make a ranking worth importing from while others still measure.
const ENOUGH_MEASURED = 3;

/**
 * After the candidates are listed while the project has no song: the next call and one line that
 * says the same thing, or null when there is nothing to do. `candidates` is the kept list,
 * `ranked` the measured ones, best fit first.
 */
export function songListMove(candidates = [], ranked = []) {
  const usable = ranked.filter((entry) => !entry.rejected && !entry.fit?.excluded);
  const open = candidates.filter((entry) => !entry.measure && !entry.failed && !entry.rejected);
  const waiting = open.filter((entry) => entry.queued).length;
  const best = usable[0];
  if (best && (!waiting || usable.length >= ENOUGH_MEASURED)) {
    return { line: `best fit of ${usable.length} measured: ${best.id} '${best.title}'. Import it (next), or measure more first.`,
      call: { tool: "project", input: { action: "import", file: best.id } } };
  }
  if (waiting) return { line: `${waiting} still measuring (about 20 s each): list again (next).`, call: SONG_LIST_CALL };
  if (open.length) {
    return { line: "None measured yet: measure the likeliest two or three (next), then list again.",
      call: { tool: "library", input: { topic: "soundtrack", measure: "<id of the likeliest song above>" } } };
  }
  const failed = candidates.find((entry) => entry.failed);
  if (failed) {
    return { line: `No song could be fetched (${oneLine(failed.failed).slice(0, 100)}): kino's own tracks are the fallback (next).`,
      call: { tool: "library", input: { topic: "music" } } };
  }
  return null;
}
