// The footage finder's agent surface: library {topic:"footage"} lists, searches, scans and notes
// found videos for one project. The service (agent/service.mjs) reads the project's saved footage
// state, calls handle(), and saves what the answer's `update` returns. Nothing here touches the
// network: `finder` (index.mjs createFootageFinder) does the searching and scanning.
//
// Each candidate video gets a short code per project (F1, F2, ...). At most FOOTAGE_KEPT stay;
// the oldest go first, but a scanned, noted or imported one is never dropped. A scan waits up to
// about 50 s; a longer one answers with its progress and a next call that repeats it.
import { call } from "../agent/next-call.mjs";
import { readTime } from "./scan.mjs";
import { candidateLine, droppedLine, nothingFoundText } from "./search.mjs";
import { scanCall, searchCall } from "./step.mjs";

/** Candidates kept per project. */
export const FOOTAGE_KEPT = 24;
/**
 * How long a scan call waits before it answers with progress (ms). Under a minute, like kino's
 * other blocking waits (render, inspire), so an agent client's tool timeout never cuts it off.
 */
export const FOOTAGE_WAIT_MS = 50_000;
/** How long a finished scan's result stays for the repeat call that collects it (ms). */
export const FOOTAGE_RESULT_KEEP_MS = 10 * 60_000;
/** Shots listed in a scan answer. */
export const FOOTAGE_SHOTS_SHOWN = 12;
/** Shots the scan answer's import call names. */
export const FOOTAGE_IMPORT_PICKS = 6;
/**
 * The line the library topics list gains once importing lands (P9); hidden until then. At most
 * 150 characters, as the topics answer is read by every agent.
 */
export const FOOTAGE_TOPIC_LINE = 'footage {search, want?, scan?, note?} (found video: YouTube, license unknown, or source:"commons"; scan ranks shots to import)';

const VERDICTS = ["pick", "maybe", "no"];
const TITLE_SHOWN = 70;

/** An expected refusal: the service turns it into an error answer with this code and next call. */
export class FootageError extends Error {
  constructor(code, message, nextCall = null) {
    super(message);
    this.code = code;
    this.nextCall = nextCall;
  }
}

/** The import call for chosen shots of one candidate. */
export const importCall = (code, shots) => call("project", { action: "import", file: code, options: { shots } });

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const short = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

/** "3:17.2": a time in a video, to a tenth of a second. */
export function stamp(seconds) {
  const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

const clockOf = (seconds) => stamp(seconds).replace(/\.\d$/, "");

/** The first line of every footage answer when the video has clips of the person's, else "". */
export function personClipsLine(count) {
  return count > 0 ? `This video has ${count} clip${count === 1 ? "" : "s"} of the person's: they lead; found clips fill the gaps.` : "";
}

/** True for a media item the footage finder imported (P9 marks it); the rest are the person's. */
export const isFoundClip = (item) => Boolean(item?.footage);

/** How many of the person's own videos the document plays: distinct video sources that were not found. */
export function personClipCount(document, media = []) {
  const found = new Set(media.filter(isFoundClip).flatMap((item) => [item.src, item.id && `/api/media/${item.id}`]).filter(Boolean));
  const sources = new Set();
  for (const scene of document?.scenes ?? []) {
    for (const layer of scene.layers ?? []) if (layer.type === "video" && layer.src && !found.has(layer.src)) sources.add(layer.src);
  }
  return sources.size;
}

/** A candidate's saved-scan id: "yt-<11>" or "commons-<pageid>". */
export const scanIdOf = (candidate) => String(candidate.id).replace(/^clip:/, "");

/**
 * What a ref names: {code: "F3"} for F3 or F3.12, {id: "clip:yt-<11>"} for yt:<11>, clip:yt-<11>
 * or a YouTube link, {id: "clip:commons-<n>"}, {top: true}, or null.
 */
export function parseRef(ref) {
  const text = oneLine(ref);
  if (!text || text.toLowerCase() === "top") return { top: true };
  const code = /^f(\d{1,3})(?:\.\d+)?$/i.exec(text);
  if (code) return { code: `F${Number(code[1])}` };
  const yt = /^(?:yt:|clip:yt-)([A-Za-z0-9_-]{11})$/.exec(text)
    ?? /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(text);
  if (yt) return { id: `clip:yt-${yt[1]}` };
  const commons = /^clip:commons-(\d+)$/.exec(text);
  if (commons) return { id: `clip:commons-${commons[1]}` };
  return null;
}

const emptyFootage = () => ({ want: "", next: 1, order: [], candidates: [] });
const kept = (candidate) => Boolean(candidate.scan || candidate.note || candidate.imported);

/**
 * Adds found candidates to the project's footage, each with its code (one it had keeps it), and
 * trims to FOOTAGE_KEPT, oldest first, never a kept one. `order` becomes these candidates' codes.
 */
export function addCandidates(footage, found) {
  const next = structuredClone(footage ?? emptyFootage());
  const order = [];
  for (const candidate of found) {
    const old = next.candidates.find((entry) => entry.id === candidate.id);
    if (old) { Object.assign(old, candidate, { code: old.code }); order.push(old.code); continue; }
    const code = `F${next.next++}`;
    next.candidates.push({ ...candidate, code });
    order.push(code);
  }
  while (next.candidates.length > FOOTAGE_KEPT) {
    const index = next.candidates.findIndex((entry) => !kept(entry) && !order.includes(entry.code));
    if (index < 0) break;
    next.candidates.splice(index, 1);
  }
  next.order = order.filter((code) => next.candidates.some((entry) => entry.code === code));
  return next;
}

function findCandidate(footage, ref) {
  const asked = parseRef(ref);
  const list = footage?.candidates ?? [];
  if (!asked) return null;
  if (asked.code) return list.find((entry) => entry.code === asked.code) ?? null;
  if (asked.id) return list.find((entry) => entry.id === asked.id) ?? null;
  // top: the best of the last search not scanned yet, else the first of it.
  const ordered = (footage?.order ?? []).map((code) => list.find((entry) => entry.code === code)).filter(Boolean);
  return ordered.find((entry) => !entry.scan) ?? ordered[0] ?? null;
}

// The candidate after `code` in the last search that is not scanned yet.
function nextCandidate(footage, code) {
  const list = footage?.candidates ?? [];
  const order = (footage?.order ?? []).filter((each) => each !== code);
  return order.map((each) => list.find((entry) => entry.code === each)).find((entry) => entry && !entry.scan) ?? null;
}

/** One shot's line: `F1.37 3:17.2-3:19.0 1.8s motion 82 face 40 match +3.1`, flags after. */
export function shotLine(code, shot, { matchShown = false } = {}) {
  const parts = [`${code}.${shot.n}`, `${stamp(shot.start)}-${stamp(shot.end)}`, `${(shot.end - shot.start).toFixed(1)}s`, `motion ${Math.round(shot.motion ?? 0)}`, `face ${Math.round(shot.face ?? 0)}`];
  if (matchShown && Number.isFinite(shot.match)) parts.push(`match ${shot.match >= 0 ? "+" : ""}${shot.match.toFixed(1)}`);
  if (shot.flags?.length) parts.push(shot.flags.join(" "));
  return parts.join(" ");
}

/** The shots a scan answer's import call names: the best clean ones (no flag but logo). */
export function importPicks(scan, most = FOOTAGE_IMPORT_PICKS) {
  return (scan.shots ?? []).filter((shot) => (shot.flags ?? []).every((flag) => flag === "logo")).slice(0, most).map((shot) => shot.n);
}

function skippedLine(skipped = {}) {
  const names = { text: "text", dark: "dark", repeats: "repeats", short: "under 0.4 s" };
  const parts = Object.entries(names).filter(([key]) => skipped[key] > 0).map(([key, name]) => `${skipped[key]} ${name}`);
  return parts.length ? `Skipped: ${parts.join(", ")}.` : "";
}

/** The scan answer: what was looked at, the 12 best shots, the skips and the match word. */
export function scanText(candidate, scan) {
  const looked = (scan.windows ?? []).reduce((sum, window) => sum + window.end - window.start, 0);
  const shots = scan.shots ?? [];
  const head = `${candidate.code} "${short(oneLine(candidate.title) || candidate.id, TITLE_SHOWN)}" · scanned ${clockOf(looked)}${candidate.seconds ? ` of ${clockOf(candidate.seconds)}` : ""} · ${shots.length} shot${shots.length === 1 ? "" : "s"}${shots.length > FOOTAGE_SHOTS_SHOWN ? `, best ${FOOTAGE_SHOTS_SHOWN}` : ""}:`;
  const lines = shots.slice(0, FOOTAGE_SHOTS_SHOWN).map((shot) => shotLine(candidate.code, shot, { matchShown: scan.matchShown }));
  const tail = [skippedLine(scan.skipped)];
  if (scan.want && !scan.matchShown) tail.push(`No visual match for "${scan.want}": shots rank on motion, faces and clean frames.`);
  tail.push(`License ${candidate.license ?? "unknown"}${candidate.license === "unknown" ? ": fine for a private video; the person checks the rights before publishing" : ""}.`);
  return [head, ...lines, ...tail.filter(Boolean)].join("\n");
}

function candidateLabel(candidate) {
  const line = candidateLine({ ...candidate, title: short(oneLine(candidate.title), TITLE_SHOWN) }, candidate.code);
  const status = candidate.imported ? "imported" : candidate.scan ? `scanned, ${candidate.scan.shots} shots` : "";
  const note = candidate.note ? `${candidate.note.verdict}: ${short(candidate.note.why, 60)}` : "";
  return [line, status, note].filter(Boolean).join(" · ");
}

// Why a scan could not run, in the agent's words, with what to do instead: the next video of the
// last search (never "top", which names the one that just failed), else a new search.
function scanFailure(error, candidate, footage = null) {
  if (error?.name === "AbortError") throw error;
  if (error?.code === "BOT_CHECK")
    return new FootageError("bot_check", `YouTube asked for a bot check, so kino pauses YouTube downloads for 15 minutes (no cookies are ever sent). Use the person's own clips, or Commons: library {topic:"footage", search, source:"commons"}.`, call("library", { topic: "footage", search: "<subject> <scene words>", source: "commons" }));
  if (error?.code === "NO_YTDLP" || error?.code === "NO_JS_RUNTIME") return new FootageError("failed", error.message, null);
  const next = nextCandidate(footage, candidate.code);
  return new FootageError("failed", `${candidate.code} could not be scanned: ${short(oneLine(error?.message ?? error), 200)}`, next ? scanCall(next.code) : searchCall());
}

// A from or to that is no time, or a stretch that ends before it starts: refused before any download.
function checkStretch(from, to, nextCall) {
  const read = (name, value) => {
    if (value === undefined || value === null || value === "") return null;
    const time = readTime(value);
    if (time === null || time < 0) throw new FootageError("bad_input", `"${name}" (${short(oneLine(value), 20)}) is not a time: use seconds (197) or minutes and seconds ("3:17").`, nextCall);
    return time;
  };
  const start = read("from", from);
  const end = read("to", to);
  if (start !== null && end !== null && end <= start) throw new FootageError("bad_input", `"to" must come after "from".`, nextCall);
}

/**
 * The footage topic. deps: finder {search(words, {signal}), searchCommons?(words),
 * scan(candidate, {want, from, to, whole, onProgress, signal}), readScan(id)}, waitMs, now.
 * handle(input, {footage, personClips, signal}) answers {text, data, nextCall, update?}: update
 * maps the saved footage state to the new one (the service applies it inside its state update).
 */
export function createFootageActions({ finder, waitMs = FOOTAGE_WAIT_MS, keepMs = FOOTAGE_RESULT_KEEP_MS }) {
  // Scans running now, by scan id and options: a repeated call joins its scan instead of starting another.
  const scans = new Map();

  function withLead(personClips, lines) {
    return [personClipsLine(personClips), ...lines].filter(Boolean).join("\n");
  }

  async function search(input, { footage, personClips, signal }) {
    const words = oneLine(input.search ?? input.query);
    const want = input.want === undefined ? null : short(oneLine(input.want), 160);
    if (!words) throw new FootageError("bad_input", 'search needs words: the series or subject and the scene, such as "<series> fight".', searchCall());
    let found;
    try {
      found = input.source === "commons"
        ? { words, candidates: await finder.searchCommons(words), dropped: {} }
        : await finder.search(words, { signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.code === "web_search_off") throw new FootageError("web_search_off", error.message, call("library", { topic: "footage", search: words }));
      if (error?.code === "BOT_CHECK") throw scanFailure(error, { code: "" });
      throw new FootageError(error?.code === "NO_YTDLP" ? "failed" : error?.code ?? "failed", short(oneLine(error?.message ?? error), 240));
    }
    const update = (saved) => {
      const next = found.candidates.length ? addCandidates(saved, found.candidates) : structuredClone(saved ?? emptyFootage());
      if (want !== null) next.want = want;
      return next;
    };
    if (!found.candidates.length) {
      return { text: withLead(personClips, [nothingFoundText(found.words ?? words, found.tried), droppedLine(found.dropped)]),
        data: { candidates: [], dropped: found.dropped }, nextCall: searchCall(), update: want !== null ? update : undefined };
    }
    const after = update(footage);
    const listed = after.order.map((code) => after.candidates.find((entry) => entry.code === code));
    const lines = [
      `Found ${listed.length} for "${found.tried ?? found.words ?? words}"${found.cached ? " (from today's search)" : ""}${after.want ? `; want: "${after.want}"` : ""}:`,
      ...listed.map(candidateLabel),
      droppedLine(found.dropped),
      "Scan one to see its best shots (it waits up to about 50 s).",
    ];
    return { text: withLead(personClips, lines), data: { candidates: listed.map(({ code, id, title, seconds, license }) => ({ code, id, title, seconds, license })), dropped: found.dropped },
      nextCall: scanCall("top"), update };
  }

  async function scan(input, { footage, personClips, signal }) {
    const ref = oneLine(input.scan);
    const asked = parseRef(ref);
    if (!asked) throw new FootageError("bad_input", `scan is "top", a code such as F1, or yt:<id>; "${short(ref, 40)}" is none of these.`, scanCall("top"));
    let saved = footage ?? emptyFootage();
    let candidate = findCandidate(saved, ref);
    // A YouTube id not in the list joins it (the agent or the person found it elsewhere).
    if (!candidate && asked.id?.startsWith("clip:yt-")) {
      const videoId = asked.id.slice("clip:yt-".length);
      saved = addCandidates(saved, [{ id: asked.id, source: "youtube", videoId, title: "", page: `https://www.youtube.com/watch?v=${videoId}`, license: "unknown" }]);
      saved.order = footage?.order ?? [];
      candidate = saved.candidates.find((entry) => entry.id === asked.id);
    }
    if (!candidate) {
      if (!saved.candidates.length) throw new FootageError("not_found", "No footage found yet: search first.", searchCall());
      throw new FootageError("not_found", `${ref} is not one of this video's footage candidates (${saved.candidates.map((entry) => entry.code).join(", ")}).`, call("library", { topic: "footage" }));
    }
    // Saves the candidate (one that joined from a yt: id) in the current state when it is missing.
    const ensure = (current) => {
      const after = structuredClone(current ?? emptyFootage());
      let entry = after.candidates.find((each) => each.id === candidate.id);
      if (!entry) {
        after.candidates.push({ ...candidate });
        entry = after.candidates.at(-1);
        after.next = Math.max(after.next ?? 1, Number(candidate.code.slice(1)) + 1);
      }
      return { after, entry };
    };
    const joined = !findCandidate(footage, ref);
    const want = input.want === undefined ? saved.want ?? "" : short(oneLine(input.want), 160);
    const options = { want, from: input.from, to: input.to, whole: input.whole === true };
    const id = scanIdOf(candidate);
    const plain = options.from === undefined && options.to === undefined && !options.whole;
    checkStretch(input.from, input.to, scanCall(candidate.code));
    const repeat = scanCall(candidate.code, { ...(input.want !== undefined ? { want } : {}), ...(plain ? {} : { from: input.from, to: input.to, ...(options.whole ? { whole: true } : {}) }) });
    // A scan saved before with the same words answers at once.
    let result = plain ? await finder.readScan(id).catch(() => null) : null;
    if (result && (result.want ?? "") !== want) result = null;
    if (!result) {
      const key = `${id}\n${JSON.stringify(options)}`;
      let job = scans.get(key);
      if (!job) {
        job = { progress: "Starting: reading the video's length, chapters and most-replayed parts." };
        // A finished scan stays a while, so the repeat call after a progress answer collects it
        // (a from/to or whole scan is not saved for readScan) instead of starting it again.
        job.promise = finder.scan(candidate, { ...options, signal: undefined, onProgress: (line) => { job.progress = line; } })
          .then((value) => ({ value }), (error) => ({ error }))
          .finally(() => { setTimeout(() => { if (scans.get(key) === job) scans.delete(key); }, keepMs).unref?.(); });
        scans.set(key, job);
      }
      let timer;
      const waited = await Promise.race([job.promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]);
      clearTimeout(timer);
      // A failure is told once: the next same call tries again.
      if (waited?.error && scans.get(key) === job) scans.delete(key);
      if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
      if (!waited) {
        return { text: withLead(personClips, [`${candidate.code} is still scanning. ${job.progress}`, "Send the same call again: it joins this scan and waits for it."]),
          data: { scanning: candidate.code }, nextCall: repeat, update: joined ? (current) => ensure(current).after : undefined };
      }
      if (waited.error) {
        if (waited.error?.code === "UNPLAYABLE") {
          const reason = waited.error.reason ?? "unavailable";
          const next = nextCandidate(saved, candidate.code);
          const update = (current) => {
            const after = structuredClone(current ?? emptyFootage());
            after.candidates = after.candidates.filter((entry) => entry.code !== candidate.code);
            after.order = (after.order ?? []).filter((code) => code !== candidate.code);
            return after;
          };
          return { text: withLead(personClips, [`${candidate.code} cannot play from here (${reason}). Dropped${next ? `; ${next.code} is next.` : "."}`]),
            data: { dropped: candidate.code, reason }, nextCall: next ? scanCall(next.code) : searchCall(), update };
        }
        throw scanFailure(waited.error, candidate, saved);
      }
      result = waited.value;
    }
    const picks = importPicks(result);
    const update = (current) => {
      const { after, entry } = ensure(current);
      entry.scan = { id, shots: (result.shots ?? []).length, at: result.scannedAt ?? null };
      if (input.want !== undefined) after.want = want;
      return after;
    };
    return { text: withLead(personClips, [scanText(candidate, result)]),
      data: { code: candidate.code, id, shots: (result.shots ?? []).slice(0, FOOTAGE_SHOTS_SHOWN).map(({ n, start, end, motion, face, match, flags }) => ({ n, start, end, motion, face, match, flags })), matchShown: Boolean(result.matchShown) },
      nextCall: picks.length ? importCall(candidate.code, picks) : nextCandidate(saved, candidate.code) ? scanCall(nextCandidate(saved, candidate.code).code) : searchCall(), update };
  }

  function note(input, { footage, personClips }) {
    const given = input.note ?? {};
    const candidate = findCandidate(footage, given.id);
    if (!candidate || parseRef(given.id)?.top) throw new FootageError("not_found", "note.id is one of this video's footage codes, such as F3 (library {topic:\"footage\"} lists them).", call("library", { topic: "footage" }));
    if (!VERDICTS.includes(given.verdict)) throw new FootageError("bad_input", 'note.verdict is "pick", "maybe" or "no".');
    const why = oneLine(given.why);
    if (why.length < 8 || why.length > 300) throw new FootageError("bad_input", "note.why says in 8 to 300 characters why this video fits or not (what its shots show, its quality, a watermark).");
    const update = (current) => {
      const after = structuredClone(current ?? emptyFootage());
      const entry = after.candidates.find((each) => each.id === candidate.id);
      if (entry) entry.note = { verdict: given.verdict, why };
      return after;
    };
    const after = update(footage);
    const next = given.verdict === "no" ? nextCandidate(after, candidate.code) : null;
    // A no moves on to the next video; a pick or maybe scans this one (a saved scan answers at once).
    const nextCall = given.verdict === "no" ? (next ? scanCall(next.code) : searchCall()) : scanCall(candidate.code);
    return { text: withLead(personClips, [`${candidate.code}: ${given.verdict} saved.`]), data: { code: candidate.code, verdict: given.verdict }, nextCall, update };
  }

  function list({ footage, personClips }) {
    const candidates = footage?.candidates ?? [];
    if (!candidates.length) {
      return { text: withLead(personClips, ["No footage found for this video yet. Search with the series or subject and the scene; want names what the shots should show, in visual words."]),
        data: { candidates: [] }, nextCall: searchCall() };
    }
    const lines = [`${candidates.length} found video${candidates.length === 1 ? "" : "s"}${footage.want ? `; want: "${footage.want}"` : ""}:`, ...candidates.map(candidateLabel)];
    const first = findCandidate(footage, "top");
    return { text: withLead(personClips, lines), data: { candidates: candidates.map(({ code, id, title, scan: scanned, note: noted, imported }) => ({ code, id, title, scanned: Boolean(scanned), ...(noted ? { note: noted.verdict } : {}), ...(imported ? { imported: true } : {}) })) },
      nextCall: first ? scanCall(first.code) : searchCall() };
  }

  async function handle(input, context) {
    if (input.note !== undefined) return note(input, context);
    if (input.scan !== undefined) return scan(input, context);
    if (input.search !== undefined || input.query !== undefined) return search(input, context);
    if (input.want !== undefined) {
      const want = short(oneLine(input.want), 160);
      return { text: withLead(context.personClips, [`want saved: "${want}". Scans rank shots by it.`]), data: { want }, nextCall: scanCall("top"),
        update: (current) => ({ ...structuredClone(current ?? emptyFootage()), want }) };
    }
    return list(context);
  }

  return { handle };
}
