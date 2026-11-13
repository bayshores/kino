// The .kinopiece file: a plain ZIP (stored, not compressed) with piece.json and media/<id> for each
// picture, video, sound or font the piece uses.
//
// Writing reuses archiveFiles (zip.mjs). Reading is new and strict, because the file may come from
// anyone: only these two kinds of entry are accepted, nothing is unpacked to a path (every media
// entry is read into memory and handed to the caller to check and store under an id kino picks
// from the entry's own name), and nothing in the file is run.
//   limits: 500 entries, 100 MB per media entry, 8 MB piece.json, 400 MB unpacked in all.
import { mkdir, mkdtemp, rm, writeFile, open, stat } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import { archiveFiles } from "./zip.mjs";
import { MAX_UPLOAD_BYTES } from "../engine/schema.js";

export const PIECE_FILE_LIMITS = Object.freeze({ entries: 500, mediaBytes: MAX_UPLOAD_BYTES, jsonBytes: 8 * 1024 * 1024, totalBytes: 400 * 1024 * 1024 });
const MEDIA_ENTRY = /^media\/([a-f0-9-]+\.[a-z0-9]+)$/;

/** Writes `<out>` (a new file) holding the piece and the media files it lists. */
export async function writePieceFile({ piece, files, mediaRoot, out, workDirectory }) {
  await mkdir(workDirectory, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(path.join(workDirectory, "piece-"));
  try {
    const json = path.join(work, "piece.json");
    await writeFile(json, JSON.stringify({ ...piece, files }), { mode: 0o600 });
    const entries = [{ name: "piece.json", path: json }, ...files.map((file) => ({ name: `media/${file.id}`, path: path.join(mediaRoot, path.basename(file.id)) }))];
    return await archiveFiles(entries, out);
  } finally { await rm(work, { recursive: true, force: true }); }
}

const refuse = (what) => { throw new Error(`This is not a usable piece file: ${what}`); };

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) refuse("it ends early.");
    done += bytesRead;
  }
  return buffer;
}

/**
 * Opens a piece file and checks its whole directory before any data is read. Returns
 * {entries:[{name, size, crc, offset}], read(entry), close()}; throws a sentence naming the problem.
 */
export async function openPieceFile(file, limits = PIECE_FILE_LIMITS) {
  const details = await stat(file).catch(() => refuse("the file was not found."));
  if (!details.isFile()) refuse("it is not a regular file.");
  const handle = await open(file, "r");
  try {
    const size = details.size;
    if (size < 22) refuse("it is too small to be a zip.");
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readAt(handle, tailLength, size - tailLength);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) if (tail.readUInt32LE(at) === 0x06054b50) { end = at; break; }
    if (end < 0) refuse("it is not a zip file.");
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0 || tail.readUInt16LE(end + 8) !== count) refuse("it is split over several disks.");
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) refuse("zip64 files are not accepted.");
    if (count > limits.entries) refuse(`it holds ${count} entries; at most ${limits.entries} are accepted.`);
    if (directorySize > 1024 * 1024 || directoryOffset + directorySize > size) refuse("its directory is damaged.");
    const directory = await readAt(handle, directorySize, directoryOffset);
    const entries = [];
    const seen = new Set();
    let position = 0, total = 0;
    for (let index = 0; index < count; index += 1) {
      if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50) refuse("its directory is damaged.");
      const madeBy = directory.readUInt16LE(position + 4), flags = directory.readUInt16LE(position + 8), method = directory.readUInt16LE(position + 10);
      const crc = directory.readUInt32LE(position + 16), packed = directory.readUInt32LE(position + 20), unpacked = directory.readUInt32LE(position + 24);
      const nameLength = directory.readUInt16LE(position + 28), extraLength = directory.readUInt16LE(position + 30), commentLength = directory.readUInt16LE(position + 32);
      const attributes = directory.readUInt32LE(position + 38), offset = directory.readUInt32LE(position + 42);
      const nameBytes = directory.subarray(position + 46, position + 46 + nameLength);
      position += 46 + nameLength + extraLength + commentLength;
      if (position > directory.length) refuse("its directory is damaged.");
      const name = nameBytes.toString("utf8");
      if (Buffer.from(name, "utf8").compare(nameBytes) !== 0 || !name) refuse("an entry name is not valid text.");
      if (name.startsWith("/") || name.includes("\\") || name.includes(":") || /[\u0000-\u001f\u007f]/u.test(name) || name.split("/").some((part) => part === ".." || part === "." || part === ""))
        refuse(`the entry "${name.replace(/[^\x20-\x7e]/g, "?").slice(0, 60)}" has an unsafe path (absolute, parent folder or odd characters).`);
      if (name !== "piece.json" && !MEDIA_ENTRY.test(name)) refuse(`the entry "${name.slice(0, 60)}" is not allowed: a piece file holds piece.json and media/<file> only.`);
      if (seen.has(name)) refuse(`the entry "${name}" appears twice.`);
      seen.add(name);
      if ((madeBy >> 8) === 3 && ((attributes >>> 16) & 0xf000) === 0xa000) refuse(`the entry "${name}" is a link, which is not accepted.`);
      if (flags & 1) refuse("encrypted entries are not accepted.");
      if (method !== 0 || packed !== unpacked) refuse("compressed entries are not accepted (a piece file is stored, not compressed).");
      if (unpacked === 0xffffffff || offset === 0xffffffff) refuse("zip64 files are not accepted.");
      const cap = name === "piece.json" ? limits.jsonBytes : limits.mediaBytes;
      if (unpacked > cap) refuse(`the entry "${name}" is ${unpacked} bytes; the limit for it is ${cap}.`);
      total += unpacked;
      if (total > limits.totalBytes) refuse(`it unpacks to more than ${limits.totalBytes} bytes.`);
      if (offset + 30 + unpacked > directoryOffset) refuse(`the entry "${name}" does not fit in the file.`);
      entries.push({ name, size: unpacked, crc, offset, nameLength });
    }
    if (!seen.has("piece.json")) refuse("it has no piece.json.");
    return {
      entries,
      async read(entry) {
        const local = await readAt(handle, 30, entry.offset);
        if (local.readUInt32LE(0) !== 0x04034b50) refuse(`the entry "${entry.name}" is damaged.`);
        const localName = (await readAt(handle, local.readUInt16LE(26), entry.offset + 30)).toString("utf8");
        if (localName !== entry.name) refuse(`the entry "${entry.name}" does not match its directory.`);
        const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (start + entry.size > directoryOffset) refuse(`the entry "${entry.name}" does not fit in the file.`);
        const data = await readAt(handle, entry.size, start);
        if (crc32(data) !== entry.crc) refuse(`the entry "${entry.name}" is damaged (its checksum is wrong).`);
        return data;
      },
      close: () => handle.close(),
    };
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}

/** The text of piece.json parsed, or a sentence saying it is broken. */
export async function readPieceJson(opened) {
  const entry = opened.entries.find((item) => item.name === "piece.json");
  try { return JSON.parse((await opened.read(entry)).toString("utf8")); }
  catch (error) { if (error.message.startsWith("This is not a usable piece file")) throw error; throw new Error("This is not a usable piece file: piece.json is not valid JSON."); }
}

