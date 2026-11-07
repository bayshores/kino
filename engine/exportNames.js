const MAX_EXPORT_BASE_CHARACTERS = 120;
const MAX_EXPORT_BASE_BYTES = 200;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Return a bounded, Unicode-safe filename base without an extension. */
export function exportBasename(name) {
  const cleaned = String(name || "Scene").normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}-]+/gu, "-").replace(/^-+|-+$/g, "");
  let base = [...(cleaned || "Scene")].slice(0, MAX_EXPORT_BASE_CHARACTERS).join("");
  while (new TextEncoder().encode(base).length > MAX_EXPORT_BASE_BYTES) base = [...base].slice(0, -1).join("");
  if (!base || base === "." || base === ".." || WINDOWS_RESERVED_BASENAME.test(base)) return "Scene";
  return base;
}

export function imageSequenceBase(name) {
  return exportBasename(name);
}

export function imageSequenceName(base, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid image sequence frame.");
  return `${base}.${String(index).padStart(5, "0")}.png`;
}

// "Scene.00012.png" belongs to the sequence "Scene". Case and Unicode form are ignored, as the
// Mac's file system ignores them.
const SEQUENCE_FRAME = /^(.+)\.\d{5,}\.png$/i;
const sameName = (name) => name.normalize("NFC").toLowerCase();

/**
 * The first free sequence base for `name`: "Scene", then "Scene_1", "Scene_2" and so on.
 * `exists(fileName)` says whether a frame is there; `folderNames`, the files already in the
 * folder when known, makes a base taken when any of its frames is there, not only frame 0.
 */
export async function availableSequenceBase(name, exists, folderNames = []) {
  const original = imageSequenceBase(name);
  const taken = new Set(folderNames.map((file) => SEQUENCE_FRAME.exec(file)?.[1]).filter(Boolean).map(sameName));
  for (let suffix = 0; suffix <= 999; suffix += 1) {
    const candidate = suffix ? `${original}_${suffix}` : original;
    if (!taken.has(sameName(candidate)) && !await exists(imageSequenceName(candidate, 0))) return candidate;
  }
  throw new Error("There are too many image sequences with this name in the selected folder.");
}

export function archiveFileNames(jobs) {
  const names = jobs.map((job) => imageSequenceBase(job.name));
  const counts = new Map(), used = new Map();
  const key = (name) => name.toLocaleLowerCase("en-US");
  for (const name of names) counts.set(key(name), (counts.get(key(name)) || 0) + 1);
  return jobs.map((job, index) => {
    const name = names[index], normalized = key(name);
    const number = (used.get(normalized) || 0) + 1;
    used.set(normalized, number);
    return `${name}${counts.get(normalized) > 1 ? ` (${number})` : ""}.${job.extension}`;
  });
}
