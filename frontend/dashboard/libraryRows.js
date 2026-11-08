// The library screen's data (library.jsx), kept apart so it can be tested without React: which
// entries a view shows, which ones this video already uses (and on which storyboard shots), and the
// note the person's picks become for the agent.

/** The entries a view shows: one technique group or one kind, a search over name and line, and
 *  only the ones in this video when `onlyUsed`. */
export function shownEntries(catalog, { group = null, kind = null, search = "", onlyUsed = false, used = new Set() } = {}) {
  const words = search.trim().toLowerCase();
  return (catalog?.entries ?? []).filter((entry) =>
    (!group || entry.groups.includes(group))
    && (!kind || entry.kind === kind)
    && (!onlyUsed || used.has(entry.id))
    && (!words || `${entry.words} ${entry.name} ${entry.line} ${entry.tags.join(" ")}`.toLowerCase().includes(words)));
}

// An in or out animation keeps its preset as {id, mode, parameters}; the library names it
// fade-in, slide-up, shrink-out (engine/animation.js PRESETS).
function presetName(animation) {
  const preset = animation.preset;
  if (!preset?.id) return ["counter", "change-text", "hide", "show"].includes(animation.kind) ? animation.kind : null;
  if (preset.id === "slide") return `slide-${preset.parameters?.direction ?? "up"}`;
  if (preset.id === "grow") return preset.mode === "out" ? "shrink-out" : "grow-in";
  if (preset.id === "rotate") return "rotate-in";
  return `${preset.id}-${preset.mode}`;
}

/** The library entries a document already uses: its moves, effects, recipes and in or out
 *  animations, as entry ids ("move:zoom-through"). */
export function usedIn(document) {
  const used = new Set();
  for (const scene of document?.scenes ?? []) {
    for (const move of scene.moves ?? []) used.add(`move:${move.name}`);
    for (const layer of scene.layers ?? []) {
      if (layer.recipe?.name) used.add(`recipe:${layer.recipe.name}`);
      for (const animation of layer.animations ?? []) {
        if (animation.kind === "effect" && animation.effect) used.add(`effect:${animation.effect}`);
        const preset = presetName(animation);
        if (preset) used.add(`animation:${preset}`);
      }
    }
  }
  return used;
}

/** The storyboard shots (1-based) whose move is this entry or one of its techniques. */
export function shotsUsing(entry, shots = []) {
  const names = new Set([entry.name, ...entry.tags]);
  return shots.flatMap((shot, index) => (shot.move?.name && names.has(shot.move.name) ? [index + 1] : []));
}

/** "shots 1, 4 and 6" */
export function shotWords(numbers) {
  if (!numbers.length) return "";
  if (numbers.length === 1) return `shot ${numbers[0]}`;
  return `shots ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

const KIND_WORDS = { move: "move", effect: "effect", animation: "animation", recipe: "recipe", look: "look", format: "video format", technique: "technique" };

/** One pick's chip: "zoom through · shot 2", or the entry's words alone. */
export function askChip(ask) {
  return ask.shot ? `${ask.words} · shot ${ask.shot}` : ask.words;
}

/** The note the picks become: each entry by its kind and name (and shot), then the person's words. */
export function askNote(asks, words = "") {
  const lines = asks.map((ask) => `${KIND_WORDS[ask.kind] ?? ask.kind} ${ask.name}${ask.shot ? ` on shot ${ask.shot}` : ""}`);
  const said = words.trim();
  if (!lines.length) return said;
  return `From the library, use: ${lines.join("; ")}.${said ? ` ${said}` : ""}`;
}

/** Adds a pick, or moves an entry already picked to the new shot. */
export function withAsk(asks, entry, shot = null) {
  const ask = { id: entry.id, kind: entry.kind, name: entry.name, words: entry.words, shot };
  return [...asks.filter((item) => item.id !== entry.id), ask];
}
