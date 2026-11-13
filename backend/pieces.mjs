// Pieces: layers or scenes saved in the workspace (one JSON file each in <data>/pieces) to use in
// any project, and to pass on as one .kinopiece file. See engine/piece.js for what a piece holds
// and backend/piece-file.mjs for the file.
//
// A piece's pictures, videos, sounds and fonts stay in the shared media folder. The piece counts
// as a reference to them (mediaReferences), so deleting the project they were uploaded to keeps
// them, and a second piece or project using the same file shares its bytes.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPiece, checkPiece, pieceLine, PIECE_NAME_MAX } from "../engine/piece.js";
import { closest } from "./agent/refs.mjs";
import { openPieceFile, readPieceJson, writePieceFile } from "./piece-file.mjs";

const MAX_FILES = 400;
const safeFileName = (name) => name.replace(/[^A-Za-z0-9 _.-]+/g, "-").trim().slice(0, 60) || "piece";

export function createPieces({ directory, mediaRoot, workDirectory, importMedia }) {
  const fileOf = (id) => path.join(directory, `${path.basename(id)}.json`);

  async function all() {
    let names;
    try { names = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const pieces = [];
    for (const name of names.filter((item) => /^[a-f0-9-]+\.json$/.test(item))) {
      try { pieces.push(JSON.parse(await readFile(path.join(directory, name), "utf8"))); } catch { /* A damaged file is left alone. */ }
    }
    return pieces.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function write(piece) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = fileOf(piece.id), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(piece), { mode: 0o600 });
    await rename(temporary, target);
  }

  function cleanName(name) {
    const value = typeof name === "string" ? name.trim() : "";
    if (!value || value.length > PIECE_NAME_MAX) throw new Error(`A piece needs a name of 1 to ${PIECE_NAME_MAX} characters: options:{resource:"pieces", action:"save", name}.`);
    return value;
  }

  async function find(reference) {
    const pieces = await all();
    const byId = pieces.find((piece) => piece.id === reference);
    if (byId) return byId;
    const matches = pieces.filter((piece) => piece.name.toLowerCase() === String(reference ?? "").toLowerCase());
    if (matches.length === 1) return matches[0];
    if (matches.length) throw new Error(`Several pieces are named "${reference}"; use an id from list.`);
    const near = closest(String(reference ?? ""), pieces.map((piece) => piece.name));
    throw new Error(pieces.length
      ? `No piece "${reference}". ${near.length ? `Did you mean ${near.map((name) => `"${name}"`).join(" or ")}? ` : ""}Saved pieces: ${pieces.map((piece) => piece.name).slice(0, 12).join(", ")}.`
      : `No piece "${reference}": none are saved yet. Save one with options:{resource:"pieces", action:"save", name, layers:[...]}.`);
  }

  async function taken(name, exceptId) {
    return (await all()).find((piece) => piece.id !== exceptId && piece.name.toLowerCase() === name.toLowerCase());
  }

  async function store(built, { replace }) {
    const same = await taken(built.name);
    if (same && !replace) throw new Error(`A piece named "${built.name}" already exists. Pick another name, or send replace:true to overwrite it.`);
    const piece = { ...built, id: same?.id ?? randomUUID(), savedAt: new Date().toISOString() };
    await write(piece);
    return piece;
  }

  return {
    line: pieceLine,
    list: all,
    find,
    async save({ name, description, envelope, canvas, replace = false }) {
      return store(buildPiece({ name: cleanName(name), description, envelope, canvas }), { replace });
    },
    async rename(reference, name) {
      const piece = await find(reference);
      const next = cleanName(name);
      if (await taken(next, piece.id)) throw new Error(`A piece named "${next}" already exists. Pick another name.`);
      await write({ ...piece, name: next });
      return { ...piece, name: next };
    },
    async delete(reference) {
      const piece = await find(reference);
      await rm(fileOf(piece.id), { force: true });
      return piece;
    },
    // Pseudo-projects for releaseProjectMedia: a piece keeps its media files alive.
    async mediaReferences() {
      return (await all()).map((piece) => ({ id: `piece:${piece.id}`, mediaIds: piece.media.map((item) => item.id) }));
    },
    async exportTo(reference, out) {
      const piece = await find(reference);
      const files = [], missing = [];
      for (const item of piece.media) {
        try {
          const record = JSON.parse(await readFile(path.join(mediaRoot, `${path.basename(item.id)}.json`), "utf8"));
          await stat(path.join(mediaRoot, path.basename(item.id)));
          files.push({ id: item.id, name: String(record.name ?? item.name).slice(0, 200), mime: record.mime });
        } catch { missing.push(item.name); }
      }
      const { id, savedAt, ...content } = piece;
      let archive;
      try { archive = await writePieceFile({ piece: content, files, mediaRoot, out, workDirectory }); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error(`${out} already exists; pick another out path.`);
        throw error;
      }
      return { piece: piece.name, path: archive.path, bytes: archive.size, media: files.length, ...(missing.length ? { missing } : {}) };
    },
    async importFrom(file, { replace = false } = {}) {
      const opened = await openPieceFile(file);
      try {
        const json = await readPieceJson(opened);
        const declared = Array.isArray(json?.files) ? json.files : [];
        if (declared.length > MAX_FILES) throw new Error(`This is not a usable piece file: it lists ${declared.length} media files; at most ${MAX_FILES} are accepted.`);
        const piece = checkPiece(json);
        // Refused before any media is stored, so a refused import leaves nothing behind.
        if ((await taken(piece.name)) && !replace) throw new Error(`A piece named "${piece.name}" already exists. Rename it first, or send replace:true to overwrite it.`);
        const incoming = [];
        for (const entry of opened.entries.filter((item) => item.name !== "piece.json")) {
          const id = entry.name.slice("media/".length);
          const info = declared.find((item) => item?.id === id);
          if (!info || typeof info.mime !== "string") throw new Error(`This is not a usable piece file: it holds media/${id}, which piece.json does not list.`);
          incoming.push({ id, name: String(info.name ?? id).slice(0, 200), mime: info.mime, bytes: await opened.read(entry) });
        }
        await importMedia(incoming);
        const saved = await store(piece, { replace });
        return { piece: saved.name, media: incoming.length, line: pieceLine(saved) };
      } finally { await opened.close(); }
    },
  };
}
