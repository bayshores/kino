// The storyboard eval (milestone B4b): after the brief, does an agent ask the storyboard stop
// as skills/kino/references/storyboard.md says? A board brief (evals/briefs.json, `board: true`)
// is also a direction brief: evals/run.mjs plays the person, and the run is scored with
// checkDirection() (evals/direction.mjs) and checkBoard() below, on the same transcript.
//
// checkBoard reads the chat: kino writes the ask (backend/agent/board-text.mjs), and the agent
// must send it as written, with its own calls listed and the fresh-eyes line true. The eval's
// Claude run has only the Skill tool besides kino's, so it cannot start a second agent: the
// line must say the check was skipped. A run whose agent can start one (a `Task` or `Agent`
// call before the ask) may say it ran.

// kino's words in the ask (backend/agent/board-text.mjs boardAsk), matched as written.
const READY = "The storyboard is ready (C";
const REPLY_LINE = "Reply: approve · approve with notes: ... · redo: ...";
const MY_CALLS = "My calls (say no to any): ";
// "Fresh-eyes check: ran." / "…: skipped (no second agent in this app)." / "…: not reported."
const FRESH_LINE = /Fresh-eyes check: (ran|skipped|not reported)\b/;
// Claude Code's tool that starts a second agent: Task, called Agent in newer versions.
const SECOND_AGENT_TOOLS = new Set(["Task", "Agent"]);
const PLAYBACK_END = "what's wrong or missing?";

// Curly quotes and apostrophes made straight, as in evals/direction.mjs.
function straight(text) {
  return String(text ?? "").normalize("NFC").replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');
}

const isPlayback = (text) => straight(text).toLowerCase().includes(PLAYBACK_END);
const asks = (text) => straight(text).includes("?");
const isBoardCheckpoint = (event) => event.type === "call" && event.tool === "notes" && !event.isError
  && event.input?.action === "checkpoint" && event.input?.id === "board";

/** Whether an agent message holds kino's storyboard ask (its first line, as written). */
export function isBoardAsk(text) {
  return straight(text).includes(READY);
}

/** What the fresh-eyes line of an ask says: "ran", "skipped", "not reported", or null (no line). */
export function freshClaim(text) {
  return FRESH_LINE.exec(straight(text))?.[1] ?? null;
}

/**
 * Checks a transcript (the version 1 format of evals/direction.mjs) against the storyboard
 * rules. Returns { passed, checks: [{id, ok, detail}] } with the checks in this order (each
 * detail is one sentence with the event numbers): board_asked, sent_as_written,
 * my_calls_listed, fresh_said, fresh_true, checkpoint_fresh, questions_once.
 */
export function checkBoard(transcript, brief) {
  if (!brief?.board) throw new Error("checkBoard needs a board brief (board: true in evals/briefs.json).");
  const events = transcript.events ?? [];
  const number = (event) => events.indexOf(event) + 1;
  const firstCall = events.find(isBoardCheckpoint);
  // The ask the agent sent: the first turn with kino's header after a board checkpoint that worked.
  const ask = firstCall ? events.slice(events.indexOf(firstCall)).find((event) => event.type === "agent" && isBoardAsk(event.text)) : null;
  const at = ask ? `the board ask (event ${number(ask)})` : "";
  const At = ask ? `The board ask (event ${number(ask)})` : "";
  const text = straight(ask?.text);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  add("board_asked", Boolean(ask), ask ? `notes checkpoint board worked at event ${number(firstCall)}, and the agent sent its ask at event ${number(ask)}.`
    : firstCall ? `notes checkpoint board worked at event ${number(firstCall)}, but 0 agent messages after it say "${READY}…".`
      : `0 notes checkpoint calls with id "board" worked, in ${events.length} events.`);

  const replyLine = text.includes(REPLY_LINE);
  add("sent_as_written", replyLine, !ask ? "No board ask, so 0 Reply lines were sent."
    : replyLine ? `${At} keeps kino's Reply line, 1 of 1.` : `${At} has 0 copies of kino's line "${REPLY_LINE}": send the ask as written.`);

  const callsLine = text.split("\n").map((line) => line.trim()).find((line) => line.startsWith(MY_CALLS));
  const calls = callsLine ? callsLine.slice(MY_CALLS.length).split(" · ").filter((call) => call.trim()).length : 0;
  add("my_calls_listed", calls > 0, !ask ? "No board ask, so 0 calls were listed."
    : calls ? `${At} lists ${calls} call${calls === 1 ? "" : "s"} under "My calls (say no to any)".`
      : `${At} has 0 "My calls (say no to any)" lines: write your own choices in the board's calls.`);

  const claim = ask ? freshClaim(ask.text) : null;
  add("fresh_said", claim === "ran" || claim === "skipped", !ask ? "No board ask, so 0 fresh-eyes lines were sent."
    : claim === "ran" || claim === "skipped" ? `${At} says the fresh-eyes check ${claim === "ran" ? "ran" : "was skipped"} (1 line).`
      : claim === "not reported" ? `${At} says "Fresh-eyes check: not reported." (0 of 2 allowed answers): ask with fresh "ran" or "skipped".`
        : `${At} has 0 fresh-eyes lines.`);

  // A claim is checked against the calls before the ask: "ran" needs a second agent started
  // (a call that failed started none), "skipped" needs none. No claim is fresh_said's failure.
  const before = ask ? events.slice(0, events.indexOf(ask)) : events;
  const started = before.filter((event) => event.type === "call" && SECOND_AGENT_TOOLS.has(event.tool) && !event.isError);
  const startedWords = !started.length ? "0 Task or Agent calls"
    : started.length === 1 ? `1 ${started[0].tool} call (event ${number(started[0])})` : `${started.length} Task or Agent calls (the first at event ${number(started[0])})`;
  const claimTrue = claim === "ran" ? started.length > 0 : claim === "skipped" ? started.length === 0 : true;
  add("fresh_true", Boolean(ask) && claimTrue, claim === "ran" || claim === "skipped"
    ? `${At} says ${claim}, with ${startedWords} before it${claimTrue ? "." : claim === "ran" ? ": a check that ran needs a second agent." : ": a second agent was started, so the check was not skipped."}`
    : !ask ? "No board ask, so 0 fresh-eyes claims are checked." : `${At} makes 0 claims about the check, with ${startedWords} before it.`);

  // What the ask's round holds: the last fresh a board checkpoint that worked sent before the
  // ask. Asked again while the board waits without fresh ("all shots"), kino keeps the one sent.
  const checkpoints = ask ? before.filter(isBoardCheckpoint) : [];
  const asked = checkpoints.at(-1) ?? null;
  const freshCall = checkpoints.filter((event) => event.input?.fresh).at(-1) ?? null;
  const sent = freshCall?.input?.fresh ?? null;
  const said = claim === "ran" || claim === "skipped" ? claim : null;
  add("checkpoint_fresh", Boolean(asked) && sent === said, !asked ? "No board ask, so 0 checkpoint calls are compared."
    : `${freshCall ? `The checkpoint at event ${number(freshCall)}` : `${checkpoints.length} board checkpoint${checkpoints.length === 1 ? "" : "s"} before it`} sent fresh ${sent ? `"${sent}"` : "(none)"} and ${at} says ${claim ? `"${claim}"` : "nothing"}${sent === said ? "." : ": they must agree."}`);

  // Questions between the brief's playback (or the start) and the ask: the board's open items
  // go out in one message.
  const playback = before.filter((event) => event.type === "agent" && isPlayback(event.text)).at(-1);
  const from = playback ? events.indexOf(playback) + 1 : 0;
  const questions = (ask ? events.slice(from, events.indexOf(ask)) : []).filter((event) => event.type === "agent" && asks(event.text) && !isPlayback(event.text));
  add("questions_once", Boolean(ask) && questions.length <= 1, !ask ? "No board ask, so 0 question messages are counted."
    : `${questions.length} message${questions.length === 1 ? "" : "s"} asked a question between ${playback ? `the playback (event ${number(playback)})` : "the start"} and ${at}; the limit is 1.`);

  return { passed: checks.every((check) => check.ok), checks };
}
