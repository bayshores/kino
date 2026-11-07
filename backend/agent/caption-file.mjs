// add_captions {file}: the kino command line and the MCP tools read a local caption file and send
// its text, so the server never opens paths an agent names. Only .srt, .vtt and .txt files of at
// most 1 MB are read.
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const CAPTION_FILE_TYPES = new Map([[".srt", "srt"], [".vtt", "vtt"], [".txt", "text"]]);
export const MAX_CAPTION_FILE_BYTES = 1_000_000;

/** {text, format} of a caption file given by its absolute path. */
export async function readCaptionFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("add_captions file must be an absolute path to a .srt, .vtt or .txt file.");
  const actualPath = await realpath(filePath).catch(() => { throw new Error(`add_captions file ${filePath} was not found.`); });
  const format = CAPTION_FILE_TYPES.get(path.extname(actualPath).toLowerCase());
  if (!format) throw new Error("add_captions file must be a .srt, .vtt or .txt file.");
  const details = await stat(actualPath);
  if (!details.isFile()) throw new Error("add_captions file must be a regular file.");
  if (details.size > MAX_CAPTION_FILE_BYTES) throw new Error(`add_captions file is over ${MAX_CAPTION_FILE_BYTES} bytes.`);
  return { text: await readFile(actualPath, "utf8"), format };
}

/** The ops with each add_captions `file` replaced by the file's text (and format). */
export async function inlineCaptionFiles(ops) {
  if (!Array.isArray(ops) || !ops.some((op) => (op?.op ?? op?.type) === "add_captions" && typeof op.file === "string")) return ops;
  return Promise.all(ops.map(async (op) => {
    if ((op?.op ?? op?.type) !== "add_captions" || typeof op.file !== "string" || op.text !== undefined) return op;
    const { text, format } = await readCaptionFile(op.file);
    const { file, ...rest } = op;
    return { ...rest, text, format: rest.format ?? format };
  }));
}
