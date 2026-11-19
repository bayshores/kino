// The screen follows the agent (Dashboard.jsx, while "Follow agent" is on): a thing that needs
// the person or that the agent works on now comes forward by itself, and the stage comes back
// when it is over. Plain data, no React.

/**
 * Where the app moves for one such thing, or null to stay. `waiting` is the thing's key while it
 * is on (a sketch round waiting for a pick, a reference being read), else null. From the stage
 * ("main"), while follow is on, it opens `away`; the stage comes back when the thing that opened
 * it is over. A place the person opened or left by hand is left alone, and a thing is acted on
 * once. `memory` is {seen, opened}, kept by the caller and changed here.
 */
export function followOpen(memory, { waiting, follow, screen }, away) {
  if (waiting === memory.seen) return null;
  memory.seen = waiting;
  if (waiting) {
    if (follow && screen === "main") { memory.opened = waiting; return away; }
    memory.opened = memory.opened && screen === away ? waiting : null;
    return null;
  }
  const back = memory.opened && screen === away ? "main" : null;
  memory.opened = null;
  return back;
}
