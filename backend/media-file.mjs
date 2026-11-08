// Reads a local media file the caller named by its absolute path, for uploading to kino.
// Used by the MCP tools and the kino command line.
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_UPLOAD_BYTES } from "../engine/schema.js";
import { LUT_MIME } from "../engine/effects/colorMath.js";

export const MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  // iPhone and QuickTime videos: kino keeps them as an MP4 with the same picture (media-remux.mjs).
  [".mov", "video/quicktime"],
  [".m4v", "video/x-m4v"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  // A colour lookup table for the lut effect.
  [".cube", LUT_MIME],
]);

// A video or sound over `maxBytes` comes back with tooLarge: the caller makes a working copy
// (media-working-copy.mjs). Any other file over it is refused.
export async function readExplicitMediaFile(filePath, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  if (!path.isAbsolute(filePath))
    throw new Error("Choose a media file by its absolute local path.");
  const actualPath = await realpath(filePath);
  const extension = path.extname(actualPath).toLowerCase();
  const mime = MEDIA_TYPES.get(extension);
  if (!mime)
    throw new Error(
      `Unsupported media type. Supported extensions: ${[...MEDIA_TYPES.keys()].join(", ")}.`,
    );
  const details = await stat(actualPath);
  if (!details.isFile())
    throw new Error("The selected path must be a regular file.");
  const tooLarge = details.size > maxBytes;
  if (tooLarge && !/^(video|audio)\//.test(mime))
    throw new Error(
      `Media files must be at most ${maxBytes} bytes (${Math.round(maxBytes / 1024 / 1024)} MB).`,
    );
  return {
    actualPath,
    mime,
    size: details.size,
    name: path.basename(actualPath),
    ...(tooLarge ? { tooLarge } : {}),
  };
}
