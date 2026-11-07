// The fresh-eyes critic: kino cannot start an agent, but the agent driving it can (a subagent).
// look {mode:"critique"} writes a packet (packet.txt and the pages as JPEG) for a critic that
// never saw the chat: the direction, the person's notes, the gates, the motion trace, the seams
// across cuts and the frames around each finding and beat boundary. The critic answers only in
// lines (CRITIQUE_FORM); notes {action:"critique", lines} records them against the packet's rev.
// A P0 line blocks a final render (critique_open) until a later round on a newer rev has no P0,
// or a waive_check {code:"critique"}. At most CRITIQUE_ROUNDS rounds a scene per story (only a
// spine rewritten from scratch starts the count again; retimed or reworded beats do not); then the
// open P0 lines go to the person as one stop (notes checkpoint {id:"critique"}), and their answer
// fixes or keeps them.
import { createHash } from "node:crypto";
import { sec } from "./describe.mjs";
import { AI_EDIT_QUESTIONS, BAR_FORM, BAR_PROBLEM, barLine } from "./bar.mjs";

// Added to the protocol when the project has a bar (bar.mjs): the comparison comes first.
export const BAR_PROTOCOL = `There is a bar: the best earlier cut, judged by the person. The bar pages show it beside this cut at the same story points. Before anything else, one line: ${BAR_FORM}. Name the times and the exact differences (captions, cut timing, devices, title and end card); never call it better because it does more. worse blocks the final render.`;

// Videos shorter than this (seconds) skip the critic.
export const CRITIQUE_UNDER = 10;
// Rounds asked of a critic per scene; after them the open lines go to the person.
export const CRITIQUE_ROUNDS = 2;
export const CRITIQUE_WAIVER = "critique";
export const CRITIQUE_FORM = "P0|P1|P2 t=<seconds> · <where> · <problem> → <exact change> · <what stays>";
// The elevation pass (taste plan T5): what would raise the edit, not only its defects. UP lines
// are suggestions shown to the agent, never a gate.
export const UP_FORM = "UP t=<seconds> · add <what> · serves <the idea or beat it serves>";
// The top-level question every round answers (a cut can be correct and still fit any app):
// OWN names the moment only this product could have; GENERIC says there is none, and blocks a
// final render like a P0 until a later round finds one or the person answers it.
export const OWN_FORM = "OWN t=<seconds> · <the moment only this product could have>";
export const GENERIC_FORM = "GENERIC · <why it could be any product> → <the moment only this product could have, from its real material>";
export const GENERIC_PROBLEM = "generic: no moment only this product could have";

// The critic's instructions: what it reads, what it may not do, how it answers.
export const CRITIQUE_PROTOCOL = [
  "You are a fresh-eyes critic of a motion video. Read packet.txt, then each page in order. Never edit anything; you have only this packet.",
  `First line, always: is there a moment only this product could have? Name it (${OWN_FORM}) or say there is none (${GENERIC_FORM}).`,
  `Then answer ONLY with lines in this form, one problem a line, worst first, nothing else (no scores, no praise, no summary):`,
  `  ${CRITIQUE_FORM}`,
  "  P0 = breaks the video: the story is unclear, a motion is jarring, text is unreadable, or it goes against the direction or a rejected line.",
  "  P1 = weakens it. P2 = polish.",
  "  A designed move (a transition, flash, freeze, typed text, rewind, fast cut run, set piece) is the maker's choice: if it bothers you, say what bothers you and the change you would make; kino turns it into a question for the person, never a cut.",
  "  t is the second it happens. where names the layer, shot or beat. The change is one exact edit (a time, a size, a move, a cut), not \"improve\". what stays says what must not change.",
  "  Example: P0 t=4.2 · cut to shot 3 · the eye has nowhere to land after the cut → start the title 0.2 s after the cut, centered · the cut time",
  `Is it an AI edit? Answer each: ${AI_EDIT_QUESTIONS.map((question, index) => `${index + 1}. ${question}`).join(" ")} Each failure is a line (P0 when it makes the whole video read as machine-made).`,
  "For each page answer: after each cut, does the eye know where to look? Does the brightness hold across the seam (no accidental flash or dip; a planned flash on a hit is fine, check holds flashes to 3 a second)? Does any element hang at the frame edge? Does this beat do its spine purpose? Can every text be read in the time shown?",
  "Then the elevation pass: what would make it impressive, not only correct. Answer each in this form, best first:",
  `  ${UP_FORM}`,
  "  1. the most forgettable 10 s, and what would make it the best moment of the video; 2. the poster frame: the one still that sells it (add poster: why); 3. what a top editor would add (a push into the part of the screen that matters, a detail lift, a hit on the music); 4. where the music should drop out or hit.",
  "  Example: UP t=12 · add a slow push into the reply box with the rest dimmed · serves the payoff beat",
  "  Signature moments may be polished, never cut or shrunk.",
  "If nothing is wrong, the defect pass is the single line: none (the UP lines still follow).",
].join("\n");

// A designed moment: something built on purpose for the story to land on: a set piece, a
// signature move, a reveal, the payoff (or its slam), or a move of the style bible (style.moves).
// A P0 whose change deletes or shrinks one (cut, remove, shrink, shorten, simplify, replace it
// with a plain cut) is not the critic's to make: it becomes a question to the person (ask:true),
// shown at the critique stop, and blocks nothing. Fixing it would pull the edit to the average.
// Designed moves count too (a critic once slowed a rewind and made a 7-cut run one take).
const MOMENT = /\b(set[- ]?pieces?|signatures?|reveals?|payoffs?|slam|key moment|hero shot|title drop|transitions?|flash(es)?|freeze[- ]?frames?|freezes?|typed|typing|typewriter|type[- ]on|rewind|stutter|strobe\w*|whip\w*|glitch\w*|zoom[- ]through|speed[- ]ramp|beat[- ]kick|cut runs?|fast cuts|montage|pop[- ]in|smash)\b/i;
// "cut" counts only as a verb on the moment ("cut it", "cut the map"), never the noun ("after
// the cut"); "drop" never as in "drop shadow".
// "cut to" only with a length ("cut to 1 s"), never a transition ("cut to the logo").
// Flattening counts as shrinking: one continuous take, slowing it, holding each shot longer, no pop.
const SHRINK = /\bcuts?\s+(it|them|this|that|the|out|down|back)\b|\bcuts?\s+to\s+\d|\b(remove|delete|drop(?!\s+shadow)|shrink|smaller|shorten|simplify|tone (it )?down|reduce|lose|kill|strip|trim|slow (it |them )?down|slower|calm\w*|soften|fewer cuts|merge)\b|\bone (continuous|long|single) (take|shot)\b|\bhold (each|every|it|them)\b|\bno pop|\bwithout (the )?(flash|pop|cuts?|transition|freeze)|\breplace\b.*\b(plain|hard cut|caption)\b/i;
// A real defect stays a P0 even at a designed moment: text that cannot be read (or not in
// time) or is cut off, a layer covering it, sound out of sync, a frozen picture, a typo.
const DEFECT = /\b(unreadable|illegible|can'?t (be )?read|cannot (be )?read|hard to read|too (fast|quick|small|short|brief) to (be )?read|not (easily )?readable|not legible|read(able)? in time|reading time|contrast|clipped|cut[- ]off|off[- ]frame|frame edge|safe zone|overlap\w*|cover(s|ed|ing)|hidden|hides?|hiding|obscur\w*|blocks? (the|its|a|our) (text|words?|title|caption|line|price|face|logo|product)|out of sync|off[- ]sync|desync\w*|lip[- ]?sync\w*|sync (is )?(off|drifts?|late|early)|frozen|typo|misspell\w*)\b/i;
export function touchesDesignedMoment(line, moves = []) {
  const about = `${line.where} ${line.problem}`;
  const named = MOMENT.test(about) || moves.some((tag) => typeof tag === "string" && tag !== "" && about.toLowerCase().includes(tag.toLowerCase()));
  return named && SHRINK.test(line.change) && !DEFECT.test(line.problem);
}

/** Whether a critic line at `at` falls inside a signature range (styleContext signatureRanges). */
export const inSignature = (at, ranges = []) => ranges.some((range) => at >= range.from - 0.25 && at <= range.to + 0.25);

// A span (t=19-25.7) counts from its start: a critic naming a stretch is not refused.
const bad = (message) => Object.assign(new Error(message), { code: "bad_input" });
const OWN_LINE = /^OWN\s+t\s*=\s*(\d+(?:\.\d+)?)\s*s?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*s?)?\s*[·|]\s*(.+?)\s*$/i;
const GENERIC_LINE = /^GENERIC\s*[·|:]\s*(.+?)\s*(?:→|->|=>|⟶|[·|])\s*(.+?)\s*$/i;
const UP_LINE = /^UP\s+t\s*=\s*(\d+(?:\.\d+)?)\s*s?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*s?)?\s*[·|]\s*(?:add\s+)?(.+?)\s*[·|]\s*(?:serves\s+)?(.+?)\s*$/i;
const LINE = /^(P[012])\s+t\s*=\s*(\d+(?:\.\d+)?)\s*s?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*s?)?\s*[·|]\s*(.+?)\s*[·|]\s*(.+?)\s*(?:→|->|=>|⟶)\s*(.+?)\s*[·|]\s*(.+?)\s*$/i;
// A line with "·" where the arrow goes ("<problem> · <change>") has the parts all the same: the
// first is where, the last two the change and what stays, the rest the problem. Saved with the arrow.
const LOOSE_LINE = /^(P[012])\s+t\s*=\s*(\d+(?:\.\d+)?)\s*s?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*s?)?\s*[·|]\s*(.+?)\s*$/i;
function looseLine(line) {
  const head = LOOSE_LINE.exec(line);
  const parts = head ? head[3].split(/\s*[·|]\s*/).filter(Boolean) : [];
  return parts.length >= 4 ? [line, head[1], head[2], parts[0], parts.slice(1, -2).join(" · "), parts.at(-2), parts.at(-1)] : null;
}
// A rating such as "7/10" or "score: 6"; the word alone is fine ("the game score hangs at the edge").
const SCORE = /\b\d+(?:\.\d+)?\s*\/\s*10\b|\b(?:score|rating)\s*[:=]\s*\d/i;

/**
 * notes critique {lines}: the critic's lines, checked one by one against CRITIQUE_FORM, UP_FORM,
 * OWN_FORM or GENERIC_FORM. Returns [{level, at, where, problem, change, keep, ask?}]; UP lines as
 * {level:"UP", at, add, serves, cutsSignature?, ask?}; OWN lines as {level:"OWN", at, what}; and a
 * GENERIC line as a blocking P0 with generic:true; a BAR line (bar.mjs) as {level:"BAR", verdict:"better",
 * why}, or, worse, as a blocking P0 with bar:true. ["none"] is an empty answer, and a "none" beside
 * other lines is skipped. A P0, P1 or P2 that cuts or flattens a designed move (`moves`: the style
 * bible's move tags) or something inside a signature range (`signatures`: styleContext
 * signatureRanges) has ask:true, unless its problem is a real defect (DEFECT): a question for the
 * person, never an edit. An UP line that cuts a signature has cutsSignature:true and ask:true.
 */
export function parseCritique(lines, duration, { moves = [], signatures = [] } = {}) {
  const list = (Array.isArray(lines) ? lines : typeof lines === "string" ? lines.split("\n") : []).map((line) => String(line ?? "").trim().replace(/^(?:[-*]|\d+[.)])\s+/, "").replace(/\*\*/g, "")).filter(Boolean);
  if (!list.length) throw bad(`lines is the critic's answer: a list of "${CRITIQUE_FORM}" lines and "${UP_FORM}" lines, or ["none"].`);
  const kept = list.filter((line) => !/^none\.?$/i.test(line));
  if (!kept.length) return [];
  if (kept.length > 40) throw bad("lines holds at most 40 critic lines: ask the critic for the worst 40.");
  return kept.map((line, index) => {
    const generic = GENERIC_LINE.exec(line);
    if (generic) return { level: "P0", generic: true, at: 0, where: "the whole video", problem: `${GENERIC_PROBLEM}: ${generic[1].slice(0, 200)}`, change: generic[2].slice(0, 240), keep: "the story" };
    const bar = barLine(line);
    if (bar) return bar.verdict === "better" ? bar : { level: "P0", bar: true, at: 0, where: "the whole video", problem: `${BAR_PROBLEM}: ${bar.why.slice(0, 220)}`, change: "make the parts the bar does better as well as the bar does them", keep: "what this cut does better" };
    const own = OWN_LINE.exec(line);
    if (own) {
      if (Number(own[1]) > duration + 0.5) throw bad(`lines[${index}]: t=${own[1]} is past the end of the ${sec(duration)} s video.`);
      return { level: "OWN", at: sec(Number(own[1])), what: own[2].slice(0, 240) };
    }
    const up = UP_LINE.exec(line);
    const match = up ? null : LINE.exec(line) ?? looseLine(line);
    if (!up && !match) throw bad(`lines[${index}] is not "${CRITIQUE_FORM}", "${UP_FORM}", "${OWN_FORM}" or "${GENERIC_FORM}": ${line.slice(0, 120)}. Ask the critic to rewrite it in that form.`);
    if (SCORE.test(line)) throw bad(`lines[${index}] gives a score: the critic names problems and exact changes, never scores.`);
    const at = Number(up ? up[1] : match[2]);
    if (at > duration + 0.5) throw bad(`lines[${index}]: t=${at} is past the end of the ${sec(duration)} s video.`);
    if (up) {
      const parsed = { level: "UP", at: sec(at), add: up[2].slice(0, 240), serves: up[3].slice(0, 160) };
      // A suggestion to cut or shrink a signature is kept as a question for the person, never
      // acted on. "drop" here is the music's drop or drop-out, a polish.
      return inSignature(at, signatures) && SHRINK.test(parsed.add.replace(/\bdrops?\b/gi, "")) ? { ...parsed, cutsSignature: true, ask: true } : parsed;
    }
    const [, level, , where, problem, change, keep] = match;
    const parsed = { level: level.toUpperCase(), at: sec(at), where: where.slice(0, 120), problem: problem.slice(0, 240), change: change.slice(0, 240), keep: keep.slice(0, 160) };
    const signatureCut = inSignature(at, signatures) && SHRINK.test(parsed.change) && !DEFECT.test(parsed.problem);
    // At any level: a P1 that flattens a designed move is no more the critic's call than a P0.
    return signatureCut || touchesDesignedMoment(parsed, moves) ? { ...parsed, ask: true } : parsed;
  });
}

/** The critic's UP lines: suggestions that raise the edit (never a gate); one that cuts a signature is a question. */
export const upLines = (lines) => lines.filter((line) => line.level === "UP" && !line.ask);

/** A P0 that blocks: not a question about a designed moment. */
export const blocksRender = (line) => line.level === "P0" && !line.ask;

export const lineText = (line) => line.level === "OWN" ? `OWN t=${line.at} · ${line.what}`
  : line.level === "BAR" ? `BAR ${line.verdict} · ${line.why}`
  : line.bar ? `BAR worse · ${line.problem.slice(BAR_PROBLEM.length + 2)}`
  : line.generic ? `GENERIC · ${line.problem.slice(GENERIC_PROBLEM.length + 2)} → ${line.change}`
  : line.level === "UP"
  ? `${line.ask ? "ask " : ""}UP t=${line.at} · add ${line.add} · serves ${line.serves}`
  : `${line.ask ? "ask " : ""}${line.level} t=${line.at} · ${line.where} · ${line.problem} → ${line.change} · ${line.keep}`;

/**
 * The direction a round was made under: a short print of the story spine's beats (role and
 * purpose; timings may move). A round saved before kino kept it counts under every direction.
 */
export function critiqueDirectionKey(brief) {
  return createHash("sha256").update(JSON.stringify(critiqueSpine(brief))).digest("hex").slice(0, 12);
}

/** The spine's beats as [role, purpose] pairs (null without a spine), kept on each round. */
export function critiqueSpine(brief) {
  return Array.isArray(brief?.style?.spine) ? brief.style.spine.map((beat) => [beat?.role ?? null, beat?.purpose ?? null]) : null;
}

const purposeWords = (purpose) => new Set(String(purpose ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

/**
 * Whether two spines tell a different story: fewer than half of the beats keep their role with a
 * purpose sharing at least half its words. Retimed, reworded or one swapped beat is the same story
 * (a test run reworded its end beat after round 1, and the count started again at round 1).
 */
export function newStory(before, now) {
  if (!before?.length || !now?.length) return false;
  let kept = 0;
  for (const [role, purpose] of before) {
    const words = purposeWords(purpose);
    if (now.some(([other, text]) => {
      if (other !== role) return false;
      const theirs = purposeWords(text);
      const shared = [...words].filter((word) => theirs.has(word)).length;
      return shared * 2 >= Math.max(words.size, theirs.size);
    })) kept += 1;
  }
  return kept * 2 < Math.max(before.length, now.length);
}

/**
 * A scene's critique record in the agent state, as it counts now: {packets:[{rev, at}],
 * rounds:[{rev, lines, at, direction, spine}], last} with only the rounds made under the current
 * story counted (a round saved without its spine always counts). `last` is the latest round under
 * any story: a new story resets the count, never the open P0 lines.
 */
export function critiqueOf(state, sceneId) {
  const kept = state?.critique?.[sceneId] ?? { packets: [], rounds: [] };
  const key = critiqueDirectionKey(state?.brief);
  const spine = critiqueSpine(state?.brief);
  const counts = (round) => round.direction == null || round.direction === key || !round.spine || !newStory(round.spine, spine);
  return { ...kept, rounds: kept.rounds.filter(counts), last: kept.rounds.at(-1) ?? null };
}

/**
 * The person's answer to the critique stop about these open lines (or null): the latest answered
 * critique round for the scene asked at or after the lines' rev. read_as "redo" = fix them as the
 * critic says; approve (or approve with notes) = keep them, in the person's words.
 */
export function personCall(state, sceneId, open) {
  if (!open) return null;
  const round = (state?.stops ?? []).findLast((entry) => entry.kind === "critique" && entry.scene === sceneId && entry.rev >= open.rev);
  return round?.status === "answered" ? { id: round.id, rev: round.rev, fix: round.answer?.read_as === "redo", words: round.answer?.words ?? "" } : null;
}

/**
 * The scene's open P0 lines (null when none): the latest round's P0s. A round only counts as
 * re-read when it was made on a newer packet, so fixing and asking again is what clears them.
 */
export function openCritique(record) {
  const latest = record.last ?? record.rounds.at(-1);
  const open = latest ? latest.lines.filter(blocksRender) : [];
  return open.length ? { rev: latest.rev, lines: open, rounds: record.rounds.length } : null;
}

/** The latest round's questions for the person (lines that would cut or flatten a designed moment), or null. */
export function critiqueQuestions(record) {
  const latest = record.last ?? record.rounds.at(-1);
  const asks = latest ? latest.lines.filter((line) => line.ask) : [];
  return asks.length ? { rev: latest.rev, lines: asks, rounds: record.rounds.length } : null;
}

/**
 * Why the bar still holds a final render (null when it does not): the project has a bar and the
 * latest critic round never compared with it (no BAR line). A BAR worse line is a P0 already.
 */
export function barGap(record, bar) {
  if (!bar) return null;
  const latest = record.last ?? record.rounds.at(-1);
  if (!latest) return null;
  if (latest.lines.some((line) => line.level === "BAR" || line.bar)) return null;
  return { why: `rev ${latest.rev}'s critic did not compare it with the bar (rev ${bar.rev} of ${bar.of}): a final render needs a BAR better line` };
}

/** Whether a scene needs a critic round before a final render step: long enough, none yet, not waived. */
export function critiqueWanted(scene, record, waivers = []) {
  if (scene.duration < CRITIQUE_UNDER) return false;
  if (waivers.some((waiver) => waiver.code === CRITIQUE_WAIVER && (waiver.target === "*" || waiver.target === scene.id))) return false;
  return !record.rounds.length;
}

/** The times worth a close frame: each finding and each spine beat boundary, merged within 0.3 s. */
export function critiqueTimes({ findings = [], spine = [], duration }) {
  const raw = [
    ...findings.filter((finding) => Number.isFinite(finding.at)).map((finding) => ({ time: finding.at, why: `${finding.severity === "error" ? "E" : "W"} ${finding.rule}` })),
    ...spine.flatMap((beat) => [{ time: beat.from, why: `${beat.role} starts` }, { time: beat.to, why: `${beat.role} ends` }]).filter((entry) => Number.isFinite(entry.time)),
  ].map((entry) => ({ ...entry, time: sec(Math.min(Math.max(0, entry.time), Math.max(0, duration - 1 / 30))) })).sort((a, b) => a.time - b.time);
  const merged = [];
  for (const entry of raw) {
    const last = merged.at(-1);
    if (last && entry.time - last.time < 0.3) { if (!last.why.includes(entry.why)) last.why += `, ${entry.why}`; continue; }
    merged.push({ ...entry });
  }
  return merged;
}
