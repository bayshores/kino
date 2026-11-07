// Names and short codes. Agents refer to scenes, layers and animations by their ID (which
// they can choose, like "hero-title"), or by a short code the server gives each one: s1 for
// scenes, L7 for layers, A12 for animations. A code is never reused in a project, so it keeps
// pointing at the same thing across edits. An animation can also be named by its layer and
// kind, such as "cta.in", or an effect by its layer and effect, such as "plate.color-wheels".
// Random UUIDs never need to be typed.
import { animationTreeEntries } from "../../engine/animationTree.js";

const PREFIX = { scene: "s", layer: "L", animation: "A" };
const KIND_BY_PREFIX = { s: "scene", l: "layer", a: "animation" };
const GONE_KEPT = 200;

export class ReferenceError extends Error {
  constructor(message, { ref, kind, suggestions = [], ambiguous = false } = {}) {
    super(message);
    this.name = "ReferenceError";
    this.code = "unknown_ref";
    this.ref = ref;
    this.kind = kind;
    this.suggestions = suggestions;
    // The name was found more than once, not missing.
    if (ambiguous) this.ambiguous = true;
  }
}

export function emptyCodes() {
  return { next: { s: 1, L: 1, A: 1 }, byId: {} };
}

// Every scene, layer and animation in document order, with what holds it. An animation inside
// animation groups has the groups' IDs in `parents` and their summed starts in `offset`.
export function documentObjects(document) {
  const scenes = [], layers = [], animations = [];
  for (const scene of document?.scenes ?? []) {
    scenes.push({ id: scene.id, scene });
    for (const { stored, parents, offset } of animationTreeEntries(scene.backgroundAnimations ?? []))
      if (stored?.id) animations.push({ id: stored.id, animation: stored, scene, layer: null, parents, offset });
    for (const layer of scene.layers ?? []) {
      layers.push({ id: layer.id, layer, scene });
      for (const { stored, parents, offset } of animationTreeEntries(layer.animations ?? []))
        if (stored?.id) animations.push({ id: stored.id, animation: stored, scene, layer, parents, offset });
    }
  }
  return { scenes, layers, animations };
}

// Gives a code to everything new in the document and forgets codes of removed objects.
// Returns a new codes object; the counters only grow, so a code is never handed out twice.
// `reserved` ({ id: code }) holds the codes an edit promised to the objects it created (see
// createResolver's declare); they are kept unless another object already has that code.
export function assignCodes(codes, document, reserved = {}) {
  const next = { ...emptyCodes().next, ...(codes?.next ?? {}) };
  const old = codes?.byId ?? {};
  const inUse = new Set(Object.values(old));
  const byId = {};
  const objects = documentObjects(document);
  const promised = (id, prefix) => {
    const code = old[id] ? null : reserved[id];
    return code && code[0] === prefix && !inUse.has(code) ? code : null;
  };
  // Other new objects are numbered after the promised codes.
  for (const kind of ["scene", "layer", "animation"]) {
    const prefix = PREFIX[kind];
    for (const { id } of objects[`${kind}s`]) {
      const code = promised(id, prefix);
      if (code) next[prefix] = Math.max(next[prefix], Number(code.slice(1)) + 1);
    }
  }
  for (const kind of ["scene", "layer", "animation"]) {
    const prefix = PREFIX[kind];
    for (const { id } of objects[`${kind}s`]) {
      const known = old[id];
      if (known && known[0] === prefix) byId[id] = known;
      else byId[id] = promised(id, prefix) ?? `${prefix}${next[prefix]++}`;
    }
  }
  // The codes of removed objects stay readable for "removed: L4" lines (the last GONE_KEPT).
  const gone = { ...(codes?.gone ?? {}) };
  for (const [id, code] of Object.entries(old)) if (!byId[id]) gone[id] = code;
  for (const id of Object.keys(byId)) delete gone[id];
  const kept = Object.entries(gone).slice(-GONE_KEPT);
  return { next, byId, ...(kept.length ? { gone: Object.fromEntries(kept) } : {}) };
}

// Edit distance where swapping two neighbouring letters ("titel" for "title") counts as one.
function distance(a, b) {
  const table = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) table[i][j] = Math.min(table[i][j], table[i - 2][j - 2] + 1);
    }
  }
  return table[a.length][b.length];
}

// The one choice a word is a near miss of (one letter off, or two for words of 8 letters or
// more; case does not count), or null when none or several are that close.
export function nearMiss(word, choices) {
  const lower = String(word).toLowerCase();
  if (lower.length < 4) return choices.find((choice) => String(choice).toLowerCase() === lower) ?? null;
  const near = [...new Set(choices)].filter((choice) => distance(lower, String(choice).toLowerCase()) <= (lower.length >= 8 ? 2 : 1));
  return near.length === 1 ? near[0] : null;
}

export function closest(word, choices, count = 3) {
  const lower = String(word).toLowerCase();
  return [...new Set(choices)]
    .map((choice) => ({ choice, score: distance(lower, String(choice).toLowerCase()) }))
    .sort((a, b) => a.score - b.score || a.choice.localeCompare(b.choice))
    .slice(0, count)
    .map((entry) => entry.choice);
}

// Looks up references in one document. `declared` holds IDs that earlier operations in the
// same batch will create, so a later operation may use them before they exist: by ID, by name,
// or by the code they will get (the next free one, in the order they are declared). A new
// name given by update_scene or update_layer also works in later operations.
export function createResolver(document, codes) {
  const objects = documentObjects(document);
  const byKind = {
    scene: new Map(objects.scenes.map((entry) => [entry.id, entry])),
    layer: new Map(objects.layers.map((entry) => [entry.id, entry])),
    animation: new Map(objects.animations.map((entry) => [entry.id, entry])),
  };
  const byCode = new Map(Object.entries(codes?.byId ?? {}).map(([id, code]) => [code.toLowerCase(), id]));
  const next = { ...emptyCodes().next, ...(codes?.next ?? {}) };
  const reserved = {};
  const codeOf = (id) => codes?.byId?.[id] ?? reserved[id] ?? null;
  const declared = { scene: new Map(), layer: new Map(), animation: new Map() };
  const names = { scene: new Map(), layer: new Map(), animation: new Map() };
  const fixes = [];
  // Objects an earlier operation of the batch deletes: their IDs and names are free again, so
  // "delete card, then add card" makes a new layer called card, not card-2.
  const removed = { scene: new Set(), layer: new Set(), animation: new Set() };
  // Layer ID prefixes a move of this batch makes its layers under (declarePrefix).
  const prefixes = new Map();
  function declarePrefix(prefix, extra = {}) { if (typeof prefix === "string" && prefix) prefixes.set(prefix.toLowerCase(), { prefix, extra }); }
  const stored = (kind) => [...byKind[kind].keys()].filter((id) => !removed[kind].has(id));

  function exists(kind, id) {
    return (byKind[kind].has(id) && !removed[kind].has(id)) || declared[kind].has(id);
  }

  function candidates(kind) {
    const ids = [...stored(kind), ...declared[kind].keys()];
    return ids.filter((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)).concat(ids.map(codeOf).filter(Boolean), [...names[kind].keys()]);
  }

  // "cta.in" names the one animation of kind in (or with that name) on layer cta, and
  // "plate.color-wheels" the one effect of that kind. Returns the matching animations.
  function layerJobMatches(ref) {
    const dot = ref.lastIndexOf(".");
    if (dot <= 0) return [];
    const layerRef = ref.slice(0, dot), job = ref.slice(dot + 1).toLowerCase();
    let layerId;
    try { layerId = resolve(layerRef, "layer"); } catch { return []; }
    const own = objects.animations.filter((entry) => entry.layer?.id === layerId && entry.parents.length === 0 && !removed.animation.has(entry.id));
    // Animations an earlier operation of this edit adds to the layer.
    for (const [id, extra] of declared.animation)
      if (extra.layerId === layerId && !byKind.animation.has(id)) own.push({ id, animation: { kind: extra.kind, name: extra.animationName } });
    const kind = own.filter((entry) => entry.animation.kind === job || String(entry.animation.name ?? "").toLowerCase() === job);
    return kind.length ? kind : own.filter((entry) => String(entry.animation.effect ?? "").toLowerCase() === job);
  }
  function layerJob(ref) {
    const matches = layerJobMatches(ref);
    return matches.length === 1 ? matches[0].id : null;
  }

  // An animation's names as an agent types them: "title.in" when its layer has one animation
  // of that kind, and its code (A3).
  function animationNames(layerId) {
    const own = objects.animations.filter((entry) => entry.layer?.id === layerId && entry.parents.length === 0);
    const layerName = codeOf(layerId) && /^[0-9a-f]{8}-/i.test(layerId) ? codeOf(layerId) : layerId;
    return own.flatMap((entry) => {
      const kind = entry.animation.kind;
      const unique = kind && own.filter((other) => other.animation.kind === kind).length === 1;
      return [...(unique ? [`${layerName}.${kind}`] : []), codeOf(entry.id) ?? entry.id];
    });
  }

  // "Did you mean": for an animation, the animations of the layer it names ("title.inn") or of
  // the operation's layer come first, then the closest of everything else.
  function suggest(ref, kind, hint = {}) {
    let layerId = null;
    if (kind === "animation") {
      const dot = ref.lastIndexOf(".");
      if (dot > 0) { try { layerId = resolve(ref.slice(0, dot), "layer"); } catch { /* not a layer */ } }
      layerId ??= hint.layerId && exists("layer", hint.layerId) ? hint.layerId : null;
    }
    const own = layerId ? closest(ref, animationNames(layerId), 3) : [];
    return [...own, ...closest(ref, candidates(kind).filter((choice) => !own.includes(choice)), Math.max(0, 3 - own.length))];
  }

  // hint.layerId: the layer the operation is about, so an unknown animation's suggestions start
  // with that layer's animations.
  function resolve(ref, kind, hint) {
    if (typeof ref !== "string" || !ref) throw new ReferenceError(`Expected a ${kind} name or code.`, { ref, kind });
    if (exists(kind, ref)) return ref;
    const coded = byCode.get(ref.toLowerCase());
    if (coded && KIND_BY_PREFIX[ref[0].toLowerCase()] === kind && exists(kind, coded)) return coded;
    if (kind === "animation") {
      const job = layerJob(ref);
      if (job) return job;
    }
    const insensitive = [...stored(kind), ...declared[kind].keys()].filter((id) => id.toLowerCase() === ref.toLowerCase());
    if (insensitive.length === 1) return insensitive[0];
    // A name given in this edit (a new object's name, or a rename).
    const renamed = names[kind].get(ref.toLowerCase());
    if (renamed) return renamed;
    // A layer or scene may also be named by its display name when exactly one has it.
    if (kind !== "animation") {
      const named = [...byKind[kind].values()].filter((entry) => !removed[kind].has(entry.id) && String((entry.layer ?? entry.scene)?.name ?? "").toLowerCase() === ref.toLowerCase());
      if (named.length === 1) return named[0].id;
      // Several layers share the name (an older project's move layers): say which ones it could be.
      if (named.length > 1) {
        const ids = named.map((entry) => entry.id);
        throw new ReferenceError(
          `"${ref}" names ${ids.length} ${kind}s: ${ids.slice(0, 8).map((id) => `${codeOf(id) ?? id} (${id})`).join(", ")}${ids.length > 8 ? ", …" : ""}. Name one by its code or ID.`,
          { ref, kind, suggestions: ids.slice(0, 8), ambiguous: true },
        );
      }
    }
    // A layer a move of this edit makes (<move id>-<part>, such as type-on-caret): its parts are
    // known only when the move runs, so any part name is taken and checked then. Only a name no
    // existing layer has (by ID, code or name) falls back to a part; it goes before the near-miss
    // fix so a new part (words-w3) is never "fixed" to an old one (words-w2).
    if (kind === "layer") {
      const lower = ref.toLowerCase();
      for (const [key, { prefix, extra }] of prefixes) {
        const part = lower.slice(key.length);
        if (!lower.startsWith(key) || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(part)) continue;
        declare("layer", `${prefix}${part}`, extra);
        return `${prefix}${part}`;
      }
    }
    // A near-miss (one or two letters off) is fixed only when exactly one name is that close,
    // and the fix is reported back.
    const pool = [...stored(kind), ...declared[kind].keys()];
    if (ref.length >= 4) {
      const near = nearMiss(ref, pool);
      if (near) {
        fixes.push(`${ref} → ${near}`);
        return near;
      }
    }
    // "footage.effect" on a layer with three effects: say which is which.
    const several = kind === "animation" ? layerJobMatches(ref) : [];
    if (several.length > 1) {
      const codes = several.map((entry) => codeOf(entry.id) ?? entry.id);
      const named = several.map((entry, index) => `${codes[index]} ${entry.animation.name ?? entry.animation.effect ?? entry.animation.kind}`);
      const effect = several.find((entry) => entry.animation.effect && several.filter((other) => other.animation.effect === entry.animation.effect).length === 1);
      throw new ReferenceError(
        `"${ref}" could be any of ${several.length} animations: ${named.join(", ")}. Name one by its code, such as "${codes[0]}"`
          + `${effect ? `, or an effect by its kind, such as "${ref.slice(0, ref.lastIndexOf("."))}.${effect.animation.effect}"` : ""}.`,
        { ref, kind, suggestions: codes, ambiguous: true },
      );
    }
    const suggestions = suggest(ref, kind, hint);
    throw new ReferenceError(
      `No ${kind} "${ref}".${suggestions.length ? ` Did you mean ${suggestions.join(", ")}?` : ""}`,
      { ref, kind, suggestions },
    );
  }

  // Records an object an earlier operation of the batch will create. New scenes and layers get
  // the next free code now, so "s2" works for the scene this edit adds; assignCodes keeps it.
  function declare(kind, id, extra = {}) {
    if (typeof id !== "string" || !id) return;
    declared[kind].set(id, extra);
    if (typeof extra.name === "string" && extra.name) names[kind].set(extra.name.toLowerCase(), id);
    if (kind !== "animation" && !byKind[kind].has(id) && !codeOf(id)) {
      const code = `${PREFIX[kind]}${next[PREFIX[kind]]++}`;
      reserved[id] = code;
      byCode.set(code.toLowerCase(), id);
    }
  }

  // A deleted layer takes its children (at any depth) and all their animations with it.
  function forget(kind, id) {
    if (typeof id !== "string" || !exists(kind, id)) return;
    const ids = new Set([id]);
    if (kind === "layer") {
      for (let grew = true; grew;) {
        grew = false;
        for (const entry of objects.layers)
          if (!ids.has(entry.id) && ids.has(entry.layer.parentId)) { ids.add(entry.id); grew = true; }
        for (const [child, extra] of declared.layer)
          if (!ids.has(child) && ids.has(extra.parentId)) { ids.add(child); grew = true; }
      }
      for (const entry of objects.animations) if (ids.has(entry.layer?.id)) forget("animation", entry.id);
      for (const [animation, extra] of declared.animation) if (ids.has(extra.layerId)) forget("animation", animation);
    }
    for (const gone of ids) {
      removed[kind].add(gone);
      declared[kind].delete(gone);
      for (const [name, target] of names[kind]) if (target === gone) names[kind].delete(name);
    }
  }

  // The ID of an object an earlier delete of this batch removed, when ref names it (by ID, code
  // or name); otherwise null.
  function removedId(kind, ref) {
    if (typeof ref !== "string" || !ref || exists(kind, ref)) return null;
    const lower = ref.toLowerCase();
    const named = [...removed[kind]].find((id) => id.toLowerCase() === lower
      || codeOf(id)?.toLowerCase() === lower || String(nameOf(kind, id) ?? "").toLowerCase() === lower);
    return named ?? null;
  }

  // True when a layer or scene has this name (ignoring case), also one this batch makes or renames.
  function nameTaken(kind, name) {
    const lower = String(name).toLowerCase();
    return names[kind].has(lower) || stored(kind).some((id) => String(nameOf(kind, id) ?? "").toLowerCase() === lower);
  }

  function rename(kind, id, name) {
    if (typeof id === "string" && exists(kind, id) && name) names[kind].set(name.toLowerCase(), id);
  }

  // The scene that holds a layer or animation (layer and animation IDs are unique in a document).
  function sceneOf(kind, id) {
    const entry = byKind[kind].get(id);
    if (entry) return entry.scene.id;
    return declared[kind].get(id)?.sceneId ?? null;
  }

  function layerOfAnimation(id) {
    return byKind.animation.get(id)?.layer?.id ?? declared.animation.get(id)?.layerId ?? null;
  }

  // The name of a scene or layer, also of one an earlier operation of the batch will create.
  function nameOf(kind, id) {
    const entry = byKind[kind].get(id);
    if (entry) return (entry.layer ?? entry.scene)?.name ?? null;
    return declared[kind].get(id)?.name ?? null;
  }

  // The type of a layer (rectangle, text, group, …), also of one an earlier operation of the
  // batch will create; null when that is not known.
  function layerTypeOf(id) {
    const entry = byKind.layer.get(id);
    if (entry) return entry.layer?.type ?? null;
    return declared.layer.get(id)?.type ?? null;
  }

  // Every layer or scene whose ID or name matches a simple glob ("arch-*", "walk-?"), ignoring
  // case, including ones an earlier operation of the batch creates, in document order.
  function matchAll(pattern, kind) {
    const escaped = pattern.replace(/[.+^$()|[\]{}\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const glob = new RegExp(`^${escaped}$`, "i");
    return [...stored(kind), ...declared[kind].keys()]
      .filter((id) => glob.test(id) || glob.test(String(nameOf(kind, id) ?? "")));
  }

  return { resolve, matchAll, declare, declarePrefix, forget, removedId, nameTaken, rename, sceneOf, layerOfAnimation, nameOf, layerTypeOf, codeOf, fixes, objects, exists, reserved };
}
