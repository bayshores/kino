// The footage finder in look {mode:"source"}:
// - ref:"F1" shows a scanned video's saved shot sheet (score.mjs keeps the best stills in one jpg,
//   4 by 3), cut back into its stills so look.mjs draws them with F1.<shot> labels. No video is
//   opened: the scan keeps only the stills.
// - with no layer, found clips (imported from a scan) group under the video they came from
//   ("F1: 12 shots"), after the person's own clips, which stay first and untagged.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { call } from "../agent/next-call.mjs";
import { FootageError, importCall, importPicks, parseRef, scanIdOf, shotLine, stamp } from "./actions.mjs";
import { SHEET_COLUMNS, SHEET_ROWS } from "./score.mjs";

/** Shot codes a group's line names before "…". */
const GROUP_CODES_SHOWN = 6;
/** Tiles a group's block shows on the clips sheet. */
export const GROUP_TILES_MOST = 12;

/** The sheet jpg cut back into its stills: {tile: {width, height}, pngs}, `count` at most. */
export async function sheetTiles(jpg, count) {
  const image = await loadImage(jpg);
  const tile = { width: Math.floor(image.width / SHEET_COLUMNS), height: Math.floor(image.height / SHEET_ROWS) };
  const pngs = [];
  for (let index = 0; index < Math.min(count, SHEET_COLUMNS * SHEET_ROWS); index += 1) {
    const canvas = createCanvas(tile.width, tile.height);
    canvas.getContext("2d").drawImage(image, (index % SHEET_COLUMNS) * tile.width, Math.floor(index / SHEET_COLUMNS) * tile.height, tile.width, tile.height, 0, 0, tile.width, tile.height);
    pngs.push(canvas.toBuffer("image/png"));
  }
  return { tile, pngs };
}

/**
 * look {mode:"source", ref}: a scanned candidate's shot sheet. footage is the project's saved
 * footage state; finder has readScan(id) and readSheet(id). Answers {tiles: [{png, label}] or
 * null (no sheet saved), tile, columns, text, data, nextCall}; a ref that is no scanned candidate
 * throws a FootageError with the call that fixes it.
 */
export async function footageSheet(ref, { footage, finder }) {
  const asked = parseRef(ref);
  const listCall = call("library", { topic: "footage" });
  if (!asked || asked.top) throw new FootageError("bad_input", 'ref is a footage code such as F1 (library {topic:"footage"} lists them).', listCall);
  const candidate = (footage?.candidates ?? []).find((entry) => (asked.code ? entry.code === asked.code : entry.id === asked.id));
  if (!candidate) {
    if (asked.id) throw new FootageError("not_found", `${String(ref).trim()} is not scanned for this video yet: the scan saves its shot sheet.`, call("library", { topic: "footage", scan: String(ref).trim() }));
    throw new FootageError("not_found", `${asked.code} is not one of this video's footage candidates.`, listCall);
  }
  const { code } = candidate;
  const id = scanIdOf(candidate);
  const scan = await finder.readScan(id).catch(() => null);
  if (!scan) throw new FootageError("not_ready", `${code} is not scanned yet: the scan saves its shot sheet.`, call("library", { topic: "footage", scan: code }));
  const byNumber = new Map((scan.shots ?? []).map((shot) => [shot.n, shot]));
  const numbers = (scan.sheet ?? []).filter((n) => byNumber.has(n));
  const jpg = numbers.length && finder.readSheet ? await finder.readSheet(id).catch(() => null) : null;
  const picks = importPicks(scan);
  const nextCall = picks.length ? importCall(code, picks) : call("library", { topic: "footage" });
  const title = String(candidate.title || scan.title || id).replace(/\s+/g, " ").trim().slice(0, 70);
  if (!jpg) {
    const shots = (scan.shots ?? []).slice(0, SHEET_COLUMNS * SHEET_ROWS);
    return { tiles: null, text: [`${code} "${title}" has no saved shot sheet (its stills could not be drawn). Its best shots:`, ...shots.map((shot) => shotLine(code, shot, { matchShown: scan.matchShown }))].join("\n"),
      data: { ref: code, id, shots: shots.map((shot) => shot.n) }, nextCall };
  }
  // scan.sheet lists the shot of each still in the jpg, in order; a number with no shot is left out.
  const { tile, pngs } = await sheetTiles(jpg, (scan.sheet ?? []).length);
  const tiles = [];
  (scan.sheet ?? []).forEach((n, index) => {
    const shot = byNumber.get(n);
    if (shot && pngs[index]) tiles.push({ png: pngs[index], label: `${code}.${n} ${stamp(shot.start)}`, shot });
  });
  const text = [
    `${code} "${title}" shot sheet: the best ${tiles.length} shot${tiles.length === 1 ? "" : "s"}, each labeled with its code and start in the video:`,
    ...tiles.map((entry) => shotLine(code, entry.shot, { matchShown: scan.matchShown })),
    `Import the ones that fit by code (options {shots:[n, …]}).`,
  ].join("\n");
  return { tiles: tiles.map(({ png, label }) => ({ png, label })), tile, columns: Math.min(SHEET_COLUMNS, tiles.length), text,
    data: { ref: code, id, labels: tiles.map((entry) => entry.label) }, nextCall };
}

/**
 * A media item's found-footage tag, from the footage extra kino saves on import
 * ({candidate, shot, ...}; candidate is a code such as F1 or a stable id such as clip:yt-<11>):
 * {group: "F1", label: "F1.37", shot: 37}. null for the person's own files.
 */
export function foundClipTag(item, footage = null) {
  const extra = item?.footage;
  if (!extra || typeof extra !== "object") return null;
  const said = String(extra.code ?? extra.candidate ?? extra.id ?? "").trim();
  // The video's id first: a clip another project cut keeps that project's code, which may name
  // another video here (found-shared).
  const list = footage?.candidates ?? [];
  const clash = Boolean(extra.candidate) && list.some((each) => each.code === said && each.id !== extra.candidate);
  const entry = (extra.candidate ? list.find((each) => each.id === extra.candidate) : null) ?? (said && !clash ? list.find((each) => each.code === said || each.id === said) : null);
  const group = entry?.code ?? (clash ? String(extra.candidate).replace(/^clip:/, "") : /^F\d+$/.test(said) ? said : said.replace(/^clip:/, "") || "found");
  const shot = Number.isFinite(Number(extra.shot)) && extra.shot !== null && extra.shot !== "" ? Number(extra.shot) : null;
  return { group, label: shot === null ? group : `${group}.${shot}`, shot };
}

const groupOrder = (group) => {
  const number = /^F(\d+)$/.exec(group);
  return number ? Number(number[1]) : Number.POSITIVE_INFINITY;
};

/**
 * look source's entries in order: each of the person's clips alone and untagged first (in the
 * order given), then the found clips grouped by video (F1 before F2), each group's shots in
 * order. clips: [{tag (foundClipTag or null), ...}]. Answers [{group: null | "F1", clips}].
 */
export function groupClips(clips) {
  const own = clips.filter((clip) => !clip.tag).map((clip) => ({ group: null, clips: [clip] }));
  const groups = new Map();
  for (const clip of clips) if (clip.tag) groups.set(clip.tag.group, [...(groups.get(clip.tag.group) ?? []), clip]);
  const found = [...groups.entries()]
    .sort(([a], [b]) => groupOrder(a) - groupOrder(b) || a.localeCompare(b))
    .map(([group, list]) => ({ group, clips: list.sort((a, b) => (a.tag.shot ?? 0) - (b.tag.shot ?? 0)) }));
  return [...own, ...found];
}

/** A group's line: `F1: 12 shots (F1.3, F1.7, …)`. */
export function groupLine(entry) {
  const labels = entry.clips.map((clip) => clip.tag.label);
  const shown = labels.slice(0, GROUP_CODES_SHOWN).join(", ");
  return `${entry.group}: ${labels.length} shot${labels.length === 1 ? "" : "s"} (${shown}${labels.length > GROUP_CODES_SHOWN ? ", …" : ""})`;
}
