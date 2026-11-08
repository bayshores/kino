// The try options screen's words and lists (tries.jsx, backend/agent/tries.mjs), as plain data.

export const ANSWER_WORDS = { none: "none of these", skip: "skipped" };

/** The round the screen shows: the one rendering or waiting, else the newest. */
export const shownRound = (tries) => (tries?.rounds ?? []).findLast((round) => round.status === "waiting" || round.status === "rendering") ?? tries?.rounds?.at(-1) ?? null;

/** What a round's answer says: "B · whip pan", "none of these", "skipped", or null. */
export function answerWords(round) {
  if (!round?.pick) return null;
  const option = round.options.find((entry) => entry.letter === round.pick);
  return option ? `${option.letter} · ${option.name}` : ANSWER_WORDS[round.pick] ?? round.pick;
}

/** The left list: every round kept, then the topics planned next. [{key, mark, text, current}] */
export function roundList(tries, current) {
  const rounds = (tries?.rounds ?? []).map((round) => ({
    key: round.id, current: round.id === current?.id, text: round.topic,
    mark: round.status === "picked" ? "✓" : round.status === "waiting" || round.status === "rendering" ? "●" : round.status === "failed" ? "!" : "–",
  }));
  return [...rounds, ...(tries?.later ?? []).map((topic, index) => ({ key: `later-${index}`, current: false, text: topic, mark: "○" }))];
}
