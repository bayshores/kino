// A library file kino makes from another one (isolate_voice's voice or background stem) keeps what
// kino already knows about its source that still holds, so the new file is not a stranger:
//
//   picture  the frames are the same (a stem in a video keeps its picture, copied as it is): the
//            shot scan (.footage-v2), faces and subjects (.people-v1, .subjects-v1) and the record's
//            frame facts (busy, edges, flat, burnedText, shots)
//   language the clip's language guess (.lang-<model>): the same people speak
//   words    its transcripts (.words-<model>[-<names>]): the stem keeps the source's timing, so its
//            line words and their times hold
//
// Sound measurements (.loudness-v1, .lufs, .peaks, .sounds-v1, .beats, .song) are of the old sound
// and are measured again on the new file. Copies are made only where the new file has none yet.
import { copyFile, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const PICTURE_SIDECARS = [/^footage-v\d+$/, /^people-v\d+$/, /^subjects-v\d+$/];
const PICTURE_FIELDS = ["busy", "edges", "flat", "burnedText", "shots", "shotCuts"];
const LANGUAGE_SIDECARS = [/^lang-/];
const WORD_SIDECARS = [/^words-/];

/**
 * Copies into the library record and sidecars of `toId` what `fromId`'s still hold, by `holds`
 * {picture, language, words}. Returns {sidecars: [suffix], fields: [name]}: what was carried.
 */
export async function carryKnowledge(mediaRoot, fromId, toId, holds = {}) {
  const carried = { sidecars: [], fields: [] };
  if (!fromId || !toId || fromId === toId) return carried;
  const patterns = [...(holds.picture ? PICTURE_SIDECARS : []), ...(holds.language ? LANGUAGE_SIDECARS : []), ...(holds.words ? WORD_SIDECARS : [])];
  let names = [];
  try { names = await readdir(mediaRoot); } catch { return carried; }
  const have = new Set(names);
  for (const file of names) {
    if (!file.startsWith(`${fromId}.`)) continue;
    const suffix = file.slice(fromId.length + 1);
    if (suffix.endsWith(".tmp") || !patterns.some((pattern) => pattern.test(suffix))) continue;
    if (have.has(`${toId}.${suffix}`)) continue;
    try { await copyFile(path.join(mediaRoot, file), path.join(mediaRoot, `${toId}.${suffix}`)); carried.sidecars.push(suffix); } catch {}
  }
  if (holds.picture) {
    try {
      const record = JSON.parse(await readFile(path.join(mediaRoot, `${fromId}.json`), "utf8"));
      for (const field of PICTURE_FIELDS) if (record[field] !== undefined) carried.fields.push(field);
      carried.record = Object.fromEntries(carried.fields.map((field) => [field, record[field]]));
    } catch {}
  }
  return carried;
}

/** Removes library files (and their record and sidecars) an edit made but did not save. */
export async function dropMadeMedia(mediaRoot, ids) {
  if (!mediaRoot || !ids?.length) return [];
  let names = [];
  try { names = await readdir(mediaRoot); } catch { return []; }
  const removed = [];
  for (const id of new Set(ids)) {
    if (typeof id !== "string" || !/^[a-f0-9-]+\.[a-z0-9]+$/.test(id)) continue;
    for (const file of names) if (file === id || file.startsWith(`${id}.`)) await rm(path.join(mediaRoot, file), { force: true }).catch(() => {});
    removed.push(id);
  }
  return removed;
}
