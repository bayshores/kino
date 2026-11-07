// The words of the top bar while something waits for the person (the bar turns orange): who
// asks, what for, and how many more wait. `rows` is needsYouRows(state); `index` is the row the
// a and d keys answer (keyTarget); `nameOf(agentId)` names a stop's agent. Null when nothing waits.
import { recommendedOption } from "./state.js";
import { APPROVAL_WORDS, STOP_WORDS } from "./words.js";

export function needsBar(rows, index = 0, nameOf = () => null, { here = false } = {}) {
  if (!rows?.length) return null;
  const row = rows[index] ?? rows[0];
  const more = rows.length - 1;
  if (row.type === "approval") {
    const { approval } = row;
    return {
      who: approval.agent?.name || approval.client || "the agent",
      what: APPROVAL_WORDS[approval.kind] ?? approval.summary ?? approval.kind,
      keys: [["a", "allow"], ["d", "deny"]],
      more,
    };
  }
  if (row.type === "judge") return { who: "kino", what: "which looks more finished", keys: [["a", "pick"]], more };
  // A material question (notes needs): a picks the recommended option; the others are on its row.
  if (row.type === "material") return { who: "the agent", what: row.need.ask, keys: [["a", `option ${recommendedOption(row.need)}`]], more };
  // Ideas are answered on the inspire screen (F3), where they are shown: a there opens it.
  if (row.type === "ideas") {
    const ideas = row.ideas;
    return { who: ideas.by?.name || "the agent", what: here ? "pick the ideas to use, then allow" : `${ideas.take.length} ideas from ${ideas.title ?? ideas.ref} · pick them on F3`,
      keys: here ? [["a", "allow"], ["d", "not yet"]] : [["a", "pick ideas"]], more };
  }
  const round = row.round ?? {};
  const what = STOP_WORDS[round.kind] ?? round.kind ?? "a stop";
  // A stop in another project is answered there.
  if (row.type === "elsewhere") return { who: row.name, what: `${what} · open it there`, keys: [], more };
  // A storyboard is approved on its own screen, where it is shown: a opens it.
  return { who: nameOf(round.agentId) || round.client || "the agent", what, keys: [["a", round.kind === "board" ? "review" : "approve"], ["d", "redo"]], more };
}
