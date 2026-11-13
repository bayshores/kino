// The try options screen's words and lists (tries.jsx, backend/agent/tries.mjs), as plain data.

export const ANSWER_WORDS = { none: "none of these", skip: "to skip" };

/** The round the screen shows: the one rendering or waiting, else the newest. */
export const shownRound = (tries) => (tries?.rounds ?? []).findLast((round) => round.status === "waiting" || round.status === "rendering") ?? tries?.rounds?.at(-1) ?? null;

/** What a round's answer says: "B, whip pan", "none of these", "to skip", or null. */
export function answerWords(round) {
  if (!round?.pick) return null;
  const option = round.options.find((entry) => entry.letter === round.pick);
  return option ? `${option.letter}, ${option.name}` : ANSWER_WORDS[round.pick] ?? round.pick;
}

/** The left list: every round kept, then the topics planned next. [{key, mark, text, current}] */
export function roundList(tries, current) {
  const rounds = (tries?.rounds ?? []).map((round) => ({
    key: round.id, current: round.id === current?.id, text: round.topic,
    mark: round.status === "picked" ? "✓" : round.status === "waiting" || round.status === "rendering" ? "●" : round.status === "failed" ? "!" : "–",
  }));
  return [...rounds, ...(tries?.later ?? []).map((topic, index) => ({ key: `later-${index}`, current: false, text: topic, mark: "○" }))];
}

/**
 * The screen a waiting round moves the app to, or null to stay. A round that starts waiting for a
 * pick opens the sketch screen ("try") from the stage ("main") while follow is on; the stage
 * comes back when the round that opened it is answered. A screen the person opened or left by
 * hand is left alone, and a round is acted on once. `memory` is {seen, opened}, kept by the
 * caller and changed here; `waiting` is the waiting round's key, or null.
 */
export function followTry(memory, { waiting, follow, screen }) {
  if (waiting === memory.seen) return null;
  memory.seen = waiting;
  if (waiting) {
    if (follow && screen === "main") { memory.opened = waiting; return "try"; }
    memory.opened = memory.opened && screen === "try" ? waiting : null;
    return null;
  }
  const back = memory.opened && screen === "try" ? "main" : null;
  memory.opened = null;
  return back;
}
