import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat, utimes,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parseMediaSource } from "../engine/mediaSource.js";

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
// A ".tmp-segment-" folder untouched this long is left over from a store that never finished.
const STALE_TEMP_MS = 60 * 60 * 1000;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_METADATA_NODES = 10_000;
const MAX_CANONICAL_DEPTH = 256;
const MAX_CANONICAL_NODES = 2_000_000;
const MAX_TOOL_PATH = 16_384;
const HASH = /^[a-f0-9]{64}$/;
const CACHE_VERSION = 1;
const CACHE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_RENDER_ENTRY = join(CACHE_ROOT, "backend", "export.mjs");
const BUNDLED_FONTS = join(CACHE_ROOT, "assets", "fonts");
const PATH_FIELDS = new Set(["path", "outputPath", "directory", "sequenceDirectory", "tempPath", "tempDirectory", "cachePath"]);

function abortError(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error("Render cache operation was cancelled.");
  if (!error.name || error.name === "Error") error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function updateCanonical(hash, value, seen = new WeakSet(), state = { nodes: 0 }, depth = 0) {
  if (depth > MAX_CANONICAL_DEPTH || ++state.nodes > MAX_CANONICAL_NODES)
    throw new RangeError("Render inputs exceed the canonical fingerprint limits.");
  if (value === null) { hash.update("null"); return; }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    hash.update("null");
    return;
  }
  if (typeof value === "string") { hash.update(JSON.stringify(value)); return; }
  if (typeof value === "boolean") { hash.update(value ? "true" : "false"); return; }
  if (typeof value === "number") { hash.update(Number.isFinite(value) ? JSON.stringify(value) : "null"); return; }
  if (typeof value === "bigint") throw new TypeError("Render inputs cannot contain BigInt values.");
  if (value instanceof Uint8Array) {
    hash.update("{\"$bytes\":");
    hash.update(JSON.stringify(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")));
    hash.update("}");
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value))
    throw new TypeError("Render inputs must contain only plain objects, arrays, and JSON values.");
  if (seen.has(value)) throw new TypeError("Render inputs cannot contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    hash.update("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index) hash.update(",");
      updateCanonical(hash, value[index], seen, state, depth + 1);
    }
    hash.update("]");
  } else {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined && typeof value[key] !== "function" && typeof value[key] !== "symbol").sort();
    hash.update("{");
    keys.forEach((key, index) => {
      if (index) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      updateCanonical(hash, value[key], seen, state, depth + 1);
    });
    hash.update("}");
  }
  seen.delete(value);
}

async function resolveImport(sourceFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(sourceFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.json`, join(base, "index.js"), join(base, "index.mjs")];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch { /* Try the next supported source extension. */ }
  }
  return null;
}

let rendererDigestPromise;
async function rendererDigest() {
  if (!rendererDigestPromise) rendererDigestPromise = (async () => {
    const rootReal = await realpath(CACHE_ROOT);
    const visited = new Set();
    const queue = [CACHE_RENDER_ENTRY];
    const digest = createHash("sha256");
    while (queue.length) {
      const path = queue.pop();
      let actual;
      try { actual = await realpath(path); }
      catch { continue; }
      const rel = relative(rootReal, actual);
      if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel) || visited.has(rel)) continue;
      visited.add(rel);
      const bytes = await readFile(actual);
      digest.update(rel.replaceAll(sep, "/"));
      digest.update("\0");
      digest.update(bytes);
      digest.update("\0");
      const source = bytes.toString("utf8");
      const imports = new Set();
      // Worker entry URLs are renderer dependencies too, even though the parent
      // never imports their modules into its own JavaScript context.
      for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*|new\s+URL\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu)) {
        if (match[1].startsWith(".")) imports.add(match[1]);
      }
      for (const specifier of imports) {
        const imported = await resolveImport(actual, specifier);
        if (imported) queue.push(imported);
      }
    }

    for (const name of ["package.json", "package-lock.json"]) {
      const path = join(rootReal, name);
      try {
        const bytes = await readFile(path);
        digest.update(name);
        digest.update("\0");
        digest.update(bytes);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        digest.update(`${name}:missing\0`);
      }
    }
    try {
      const fontNames = (await readdir(join(rootReal, "assets", "fonts")))
        .filter((name) => /\.(?:ttf|otf|woff2?)$/iu.test(name))
        .sort();
      for (const name of fontNames) {
        const path = join(rootReal, "assets", "fonts", name);
        const bytes = await readFile(path);
        digest.update(`bundled-font:${name}\0`);
        digest.update(bytes);
        digest.update("\0");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      digest.update("bundled-fonts:missing\0");
    }
    digest.update(JSON.stringify({
      node: process.versions.node ?? null,
      electron: process.versions.electron ?? null,
      v8: process.versions.v8 ?? null,
      modules: process.versions.modules ?? null,
      platform: process.platform,
      arch: process.arch,
    }));
    return digest.digest("hex");
  })();
  return rendererDigestPromise;
}

function configuredTools() {
  return [
    ["ffmpeg", process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg"],
    ["ffprobe", process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe"],
    ["gifski", process.env.KINO_GIFSKI ?? "gifski"],
  ];
}

async function toolFingerprints() {
  const values = [];
  for (const [name, configured] of configuredTools()) {
    let resolvedPath = null;
    const candidates = configured.includes(sep) || isAbsolute(configured)
      ? [resolve(configured)]
      : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, configured));
    for (const candidate of candidates.slice(0, 4096)) {
      try {
        if (candidate.length > MAX_TOOL_PATH) break;
        await access(candidate, fsConstants.X_OK);
        const actual = await realpath(candidate);
        const info = await stat(actual, { bigint: true });
        if (!info.isFile()) continue;
        resolvedPath = {
          path: actual,
          size: info.size.toString(),
          modifiedNs: info.mtimeNs?.toString() ?? String(Number(info.mtimeMs) * 1e6),
          inode: info.ino.toString(),
          device: info.dev.toString(),
          mode: info.mode.toString(),
        };
        break;
      } catch { /* An unavailable configured tool remains fingerprinted as unavailable. */ }
    }
    const fingerprint = { name, configured, resolved: resolvedPath };
    values.push(fingerprint);
  }
  return values;
}

function mediaReferences(...values) {
  const found = new Map();
  const seen = new WeakSet();
  const visit = (value) => {
    if (typeof value === "string") {
      if (!value.startsWith("/api/media/")) return;
      const parsed = parseMediaSource(value);
      const item = parsed
        ? { id: parsed.id, frame: parsed.frame }
        : { id: "", frame: null, invalid: true };
      const key = `${item.id}\0${item.frame ?? ""}\0${item.invalid ? "invalid" : ""}`;
      found.set(key, item);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) value.forEach(visit);
    else if (isPlainObject(value)) Object.values(value).forEach(visit);
    seen.delete(value);
  };
  values.forEach(visit);
  return [...found.values()].sort((left, right) => `${left.id}:${left.frame ?? ""}`.localeCompare(`${right.id}:${right.frame ?? ""}`));
}

// The digests of files read recently, by where the file is and when it last changed. A look
// sheet asks for the key of each of its 12 frames, and each key fingerprints every media file
// of the scene: without this, a ten-minute scene with a few large videos read them in full
// 12 times over. A write changes a file's ctime, but only to the file system's clock tick
// (10 ms on a Linux kernel with HZ=100, such as WSL 2's; 2 s on FAT), and a file deleted and
// written again can get the same inode: two versions of the same size written within one tick
// look the same. As Git does with "racily clean" files, a file changed less than
// FRESH_FILE_NS ago is read every time and remembered only once it is older.
const FILE_DIGESTS = new Map();
const FILE_DIGEST_ENTRIES = 256;
const FRESH_FILE_NS = 3_000_000_000n;

function fileStamp(path, info) {
  return `${path}\0${info.dev}\0${info.ino}\0${info.size}\0${info.mtimeNs}\0${info.ctimeNs}`;
}

async function hashFile(path, { maxBytes = Infinity } = {}) {
  const before = await stat(path, { bigint: true });
  if (!before.isFile()) throw new Error("Only regular files can be fingerprinted.");
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || (Number.isFinite(maxBytes) && before.size > BigInt(maxBytes)))
    throw new RangeError("A render dependency exceeds the supported fingerprint size.");
  const stamp = fileStamp(path, before);
  const known = FILE_DIGESTS.get(stamp);
  if (known) {
    FILE_DIGESTS.delete(stamp);
    FILE_DIGESTS.set(stamp, known);
    return { ...known };
  }
  const result = await hashFileContents(path, before);
  const changed = before.ctimeNs > before.mtimeNs ? before.ctimeNs : before.mtimeNs;
  if (BigInt(Date.now()) * 1_000_000n - changed >= FRESH_FILE_NS) {
    FILE_DIGESTS.set(stamp, result);
    if (FILE_DIGESTS.size > FILE_DIGEST_ENTRIES) FILE_DIGESTS.delete(FILE_DIGESTS.keys().next().value);
  }
  return { ...result };
}

async function hashFileContents(path, before) {
  const digest = createHash("sha256");
  let bytes = 0;
  await pipeline(createReadStream(path), new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      digest.update(chunk);
      callback(null, chunk);
    },
  }), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  const after = await stat(path, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino)
    throw new Error("A render dependency changed while it was being fingerprinted.");
  return { size: bytes, sha256: digest.digest("hex") };
}

async function resolveMediaDependency(id, mediaRoot) {
  if (!id || !/^[a-f0-9-]+\.[a-z0-9]+$/u.test(id)) return { id, state: "invalid" };
  if (!mediaRoot || typeof mediaRoot !== "string") return { id, state: "no-media-root" };
  let root;
  try { root = await realpath(mediaRoot); }
  catch (error) { return { id, state: error.code === "ENOENT" ? "media-root-missing" : `media-root-${error.code ?? "unavailable"}` }; }
  const candidate = resolve(root, id);
  if (basename(candidate) !== id || !candidate.startsWith(`${root}${sep}`)) return { id, state: "invalid" };
  let actual;
  try { actual = await realpath(candidate); }
  catch (error) { return { id, state: error.code === "ENOENT" ? "missing" : `unavailable-${error.code ?? "unknown"}` }; }
  if (!actual.startsWith(`${root}${sep}`)) return { id, state: "outside-media-root" };
  try { return { id, state: "present", ...await hashFile(actual) }; }
  catch (error) { return { id, state: `unavailable-${error.code ?? error.name ?? "unknown"}` }; }
}

function fontIdentity(face) {
  return {
    id: face?.id ?? null,
    family: face?.family ?? null,
    aliases: Array.isArray(face?.aliases) ? face.aliases : [],
    weight: face?.weight ?? null,
    style: face?.style ?? null,
    src: face?.src ?? null,
    url: face?.url ?? null,
    subset: face?.subset ?? null,
    defaultSubset: face?.defaultSubset ?? null,
    unicodeRange: face?.unicodeRange ?? null,
    packageVersion: face?.packageVersion ?? null,
    variableAxes: face?.variableAxes ?? null,
  };
}

async function fingerprintFonts(fonts, mediaRoot) {
  const faces = Array.isArray(fonts?.faces) ? fonts.faces : [];
  const output = [];
  for (const face of faces) {
    const identity = fontIdentity(face);
    let bytes = face?.font?.stream?.buffer;
    if (bytes instanceof Uint8Array) {
      bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      output.push({ ...identity, bytes: { size: bytes.length, sha256: hashBytes(bytes) } });
      continue;
    }
    const src = typeof face?.src === "string" ? face.src : "";
    const media = parseMediaSource(src);
    if (media) {
      output.push({ ...identity, bytes: await resolveMediaDependency(media.id, mediaRoot) });
      continue;
    }
    const cached = /^\/api\/fonts\/fs-cache-([a-f0-9]{64})\.ttf$/u.exec(face?.url ?? "");
    if (cached) {
      output.push({ ...identity, bytes: { state: "content-addressed", sha256: cached[1] } });
      continue;
    }
    const bundled = /^\/api\/fonts\/([^/?#]+)$/u.exec(src);
    if (bundled) {
      let name;
      try { name = decodeURIComponent(bundled[1]); } catch { name = ""; }
      if (name && basename(name) === name && extname(name).match(/^\.(?:ttf|otf|woff2?)$/iu)) {
        try {
          const path = join(BUNDLED_FONTS, name);
          const actual = await realpath(path);
          if (actual.startsWith(`${await realpath(BUNDLED_FONTS)}${sep}`)) {
            output.push({ ...identity, bytes: await hashFile(actual) });
            continue;
          }
        } catch { /* Keep the unavailable source visible in the key below. */ }
      }
    }
    throw new Error(`Cannot fingerprint font face “${String(face?.id ?? face?.family ?? "unknown").slice(0, 120)}”; bypass render cache.`);
  }
  output.sort((left, right) => `${left.id}:${left.src}:${left.subset}`.localeCompare(`${right.id}:${right.src}:${right.subset}`));
  return output;
}

// `graphics` (optional): render-devices.mjs graphicsCacheInput (the graphics setting,
// KINO_RASTER_GPU, the card variables and whether the display is WSLg's), which change the
// pixels Chromium draws (a key made without it stays the same).
export async function renderContentKey(scene, options = {}, { fonts, mediaRoot, scope, graphics } = {}) {
  if (typeof scope !== "string" || !scope.trim() || scope.length > 4096)
    throw new TypeError("A non-empty render cache scope string is required.");
  const hash = createHash("sha256");
  hash.update(`kino-render-content-key-v${CACHE_VERSION}\0`);
  hash.update(await rendererDigest());
  hash.update("\0tools\0");
  hash.update(JSON.stringify(await toolFingerprints()));
  hash.update("\0scope\0");
  hash.update(JSON.stringify(scope));
  hash.update("\0scene\0");
  updateCanonical(hash, scene);
  hash.update("\0options\0");
  updateCanonical(hash, options);
  if (typeof graphics === "string") hash.update(`\0graphics\0${graphics}`);
  hash.update("\0fonts\0");
  hash.update(JSON.stringify(await fingerprintFonts(fonts, mediaRoot)));
  hash.update("\0media\0");
  const references = mediaReferences(scene, options);
  const media = [];
  for (const item of references) {
    media.push(item.invalid ? item : { ...item, asset: await resolveMediaDependency(item.id, mediaRoot) });
  }
  hash.update(JSON.stringify(media));
  return hash.digest("hex");
}

function cleanMetadata(value, state = { nodes: 0, bytes: 0 }, depth = 0) {
  if (depth > 32) throw new RangeError("Render cache metadata is too deeply nested.");
  if (++state.nodes > MAX_METADATA_NODES) throw new RangeError("Render cache metadata has too many values.");
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value);
    if (state.bytes > MAX_METADATA_BYTES) throw new RangeError("Render cache metadata is too large.");
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Render cache metadata must contain finite numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_NODES - state.nodes) throw new RangeError("Render cache metadata has too many values.");
    return value.map((item) => cleanMetadata(item, state, depth + 1));
  }
  if (!isPlainObject(value)) throw new TypeError("Render cache metadata must be plain JSON data.");
  const result = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (PATH_FIELDS.has(key) || child === undefined) continue;
    state.bytes += Buffer.byteLength(key);
    if (state.bytes > MAX_METADATA_BYTES) throw new RangeError("Render cache metadata is too large.");
    result[key] = cleanMetadata(child, state, depth + 1);
  }
  return result;
}

function validMetadata(value) {
  return isPlainObject(value) && Object.keys(value).length <= 256;
}

async function writeJsonSync(path, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_METADATA_BYTES) throw new RangeError("Render cache metadata is too large.");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

async function syncDirectory(path) {
  try {
    const handle = await open(path, fsConstants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
  }
}

async function syncFile(path) {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

function hashAndSizeTransform() {
  const hash = createHash("sha256");
  let size = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { transform, digest: () => hash.digest("hex"), size: () => size };
}

function createSerialLock() {
  let tail = Promise.resolve();
  return async (callback) => {
    const previous = tail;
    let release;
    tail = new Promise((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await callback(); }
    finally { release(); }
  };
}

function checkLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new TypeError("maxBytes must be a positive safe integer.");
  return bytes;
}

/**
 * The render cache: finished export files by content key, on disk under `directory`, at most
 * `maxBytes` in all (oldest used first out). Besides key/restore/store it answers usage(),
 * clear() (every entry not being read or written right now) and limit(bytes), which changes
 * the size at once and removes the oldest entries until the cache fits.
 */
export function createSegmentCache({ directory, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof directory !== "string" || !directory.trim()) throw new TypeError("A render cache directory is required.");
  // limit() changes this while the cache is open (the dashboard's render cache size).
  checkLimit(maxBytes);
  const requestedRoot = resolve(directory);
  const active = new Set();
  const temporary = new Set();
  // Keys whose entry folder a restore or store is using right now: clear() and eviction leave them.
  const inUse = new Map();
  const keyLocks = new Map();
  const serialStore = createSerialLock();
  let rootPromise;
  let closed = false;
  let closingPromise;

  async function rootPath() {
    if (!rootPromise) rootPromise = (async () => {
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const details = await lstat(requestedRoot);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Render cache root must be a real directory, not a symlink.");
      const actual = await realpath(requestedRoot);
      await chmod(actual, 0o700);
      return actual;
    })();
    return rootPromise;
  }

  function track(callback) {
    if (closed) return Promise.reject(new Error("Render cache is closed."));
    const promise = Promise.resolve().then(callback);
    active.add(promise);
    promise.then(() => active.delete(promise), () => active.delete(promise));
    return promise;
  }

  async function withKeyLock(key, callback) {
    const previous = keyLocks.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise((resolvePromise) => { release = resolvePromise; });
    const queued = previous.then(() => next);
    keyLocks.set(key, queued);
    await previous;
    try { return await callback(); }
    finally {
      release();
      if (keyLocks.get(key) === queued) keyLocks.delete(key);
    }
  }

  async function using(key, callback) {
    inUse.set(key, (inUse.get(key) ?? 0) + 1);
    try { return await callback(); }
    finally {
      const left = inUse.get(key) - 1;
      if (left > 0) inUse.set(key, left);
      else inUse.delete(key);
    }
  }

  function entryPaths(root, key) {
    const shard = join(root, key.slice(0, 2));
    return { shard, entry: join(shard, key), artifact: join(shard, key, "artifact"), manifest: join(shard, key, "manifest.json") };
  }

  // `anySize` reads an entry larger than today's limit too (usage counts what is on disk).
  async function readManifest(paths, { anySize = false } = {}) {
    try {
      const shard = await lstat(paths.shard);
      if (!shard.isDirectory() || shard.isSymbolicLink()) return null;
      const entry = await lstat(paths.entry);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
      const manifestInfo = await lstat(paths.manifest);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_METADATA_BYTES) return null;
      const raw = JSON.parse(await readFile(paths.manifest, "utf8"));
      if (raw?.version !== CACHE_VERSION || !HASH.test(raw.key) || raw.key !== basename(paths.entry) ||
          raw.artifact !== "artifact" || !Number.isSafeInteger(raw.size) || raw.size < 1 || (!anySize && raw.size > maxBytes) ||
          !Number.isFinite(raw.savedAt) || !HASH.test(raw.sha256) || !validMetadata(raw.metadata)) return null;
      const artifactInfo = await lstat(paths.artifact);
      if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink() || artifactInfo.size !== raw.size) return null;
      return { ...raw, manifestModifiedMs: manifestInfo.mtimeMs };
    } catch { return null; }
  }

  async function verifyArtifact(path, manifest, signal) {
    throwIfAborted(signal);
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(createReadStream(path), new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback();
      },
    }), new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { signal });
    throwIfAborted(signal);
    return size === manifest.size && hash.digest("hex") === manifest.sha256;
  }

  // Every entry folder in the cache: { key, path, size, modified } for each readable entry
  // (artifact and manifest bytes), the paths of unreadable ones, and the ".tmp-segment-" folders.
  async function scan(root, { anySize = false } = {}) {
    const entries = [];
    const broken = [];
    const temps = [];
    let shards = [];
    try { shards = await readdir(root); } catch { return { entries, broken, temps }; }
    for (const shardName of shards) {
      if (shardName.startsWith(".tmp-segment-")) {
        const temp = join(root, shardName);
        try {
          const info = await lstat(temp);
          if (info.isDirectory() && !info.isSymbolicLink()) temps.push({ path: temp, modified: info.mtimeMs });
        } catch { /* It finished or was removed meanwhile. */ }
        continue;
      }
      if (!/^[a-f0-9]{2}$/u.test(shardName)) continue;
      const shard = join(root, shardName);
      let shardInfo;
      try { shardInfo = await lstat(shard); } catch { continue; }
      if (!shardInfo.isDirectory() || shardInfo.isSymbolicLink()) continue;
      let names = [];
      try { names = await readdir(shard); } catch { continue; }
      for (const key of names) {
        if (!HASH.test(key)) continue;
        const paths = entryPaths(root, key);
        const manifest = await readManifest(paths, { anySize });
        if (!manifest) { broken.push({ key, path: paths.entry }); continue; }
        let manifestSize = 0;
        try { manifestSize = (await stat(paths.manifest)).size; } catch { continue; }
        entries.push({ key, path: paths.entry, size: manifest.size + manifestSize, modified: manifest.manifestModifiedMs, metadata: manifest.metadata });
      }
    }
    return { entries, broken, temps };
  }

  // Removes stale temporary folders and unreadable entries, then the least recently used entries
  // until the cache fits in maxBytes. Entries in use (and `keepKey`) stay.
  async function evict(root, keepKey = null) {
    const { entries, broken, temps } = await scan(root);
    for (const temp of temps) {
      if (temporary.has(temp.path) || Date.now() - temp.modified <= STALE_TEMP_MS) continue;
      await rm(temp.path, { recursive: true, force: true }).catch(() => {});
    }
    for (const entry of broken) if (!inUse.has(entry.key)) await rm(entry.path, { recursive: true, force: true }).catch(() => {});
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((left, right) => left.modified - right.modified || left.key.localeCompare(right.key));
    for (const entry of entries) {
      if (total <= maxBytes) break;
      if (entry.key === keepKey || inUse.has(entry.key)) continue;
      try {
        await rm(entry.path, { recursive: true, force: true });
        total -= entry.size;
      } catch { /* A folder that cannot be removed now is tried again next time. */ }
    }
  }

  async function validateEntry(key, signal) {
    const root = await rootPath();
    const paths = entryPaths(root, key);
    const manifest = await readManifest(paths);
    if (!manifest || !(await verifyArtifact(paths.artifact, manifest, signal))) return null;
    return { root, paths, manifest };
  }

  const api = {
    key(scene, options = {}, context = {}) {
      return track(() => renderContentKey(scene, options, context));
    },

    restore(key, outputPath, { signal } = {}) {
      return track(() => using(key, async () => {
        if (!HASH.test(key)) throw new TypeError("Render cache key must be a lowercase SHA-256 hash.");
        if (typeof outputPath !== "string" || !outputPath) throw new TypeError("A render cache output path is required.");
        throwIfAborted(signal);
        const root = await rootPath();
        const paths = entryPaths(root, key);
        const manifest = await readManifest(paths);
        if (!manifest) {
          await rm(paths.entry, { recursive: true, force: true }).catch(() => {});
          return null;
        }
        const outputDirectory = dirname(resolve(outputPath));
        const temp = join(outputDirectory, `.kino-cache-restore-${randomUUID()}.tmp`);
        let published = false;
        try {
          const file = await lstat(paths.artifact);
          if (!file.isFile() || file.isSymbolicLink() || file.size !== manifest.size) {
            await rm(paths.entry, { recursive: true, force: true });
            return null;
          }
          const digest = hashAndSizeTransform();
          await pipeline(createReadStream(paths.artifact), digest.transform, createWriteStream(temp, { flags: "wx", mode: 0o600 }), { signal });
          throwIfAborted(signal);
          if (digest.size() !== manifest.size || digest.digest() !== manifest.sha256) {
            await rm(temp, { force: true });
            await rm(paths.entry, { recursive: true, force: true });
            return null;
          }
          await syncFile(temp);
          await rename(temp, resolve(outputPath));
          published = true;
          await syncDirectory(outputDirectory);
          await utimes(paths.manifest, new Date(), new Date()).catch(() => {});
          return { ...manifest.metadata, path: outputPath, size: manifest.size, cacheHit: true };
        } finally {
          if (!published) await rm(temp, { force: true }).catch(() => {});
        }
      }));
    },

    /**
     * Where an entry's file is, without copying it: {path, size, metadata} or null. Its size is
     * checked against its manifest (not its hash) and it counts as just used. For files served
     * straight from the cache (preview segments); a later eviction may remove the file.
     */
    locate(key) {
      return track(async () => {
        if (!HASH.test(key)) throw new TypeError("Render cache key must be a lowercase SHA-256 hash.");
        const paths = entryPaths(await rootPath(), key);
        const manifest = await readManifest(paths);
        if (!manifest) return null;
        await utimes(paths.manifest, new Date(), new Date()).catch(() => {});
        return { path: paths.artifact, size: manifest.size, metadata: manifest.metadata };
      });
    },

    store(key, outputPath, metadata = {}, { signal } = {}) {
      return track(() => using(key, () => withKeyLock(key, () => serialStore(async () => {
        if (!HASH.test(key)) throw new TypeError("Render cache key must be a lowercase SHA-256 hash.");
        if (typeof outputPath !== "string" || !outputPath) throw new TypeError("A render cache output path is required.");
        throwIfAborted(signal);
        const root = await rootPath();
        const paths = entryPaths(root, key);
        const existing = await validateEntry(key, signal).catch((error) => {
          if (signal?.aborted) throw error;
          return null;
        });
        if (existing) return true;
        const info = await lstat(outputPath).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!info || !info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) return false;
        const cleaned = cleanMetadata(metadata);
        if (!validMetadata(cleaned)) throw new TypeError("Render cache metadata must be a bounded JSON object.");
        const metadataBytes = Buffer.byteLength(JSON.stringify(cleaned));
        if (metadataBytes > MAX_METADATA_BYTES) throw new RangeError("Render cache metadata is too large.");
        const savedAt = Date.now();
        const manifestBytes = Buffer.byteLength(JSON.stringify({
          version: CACHE_VERSION, key, artifact: "artifact", size: info.size,
          sha256: "0".repeat(64), savedAt, metadata: cleaned,
        }));
        if (info.size + manifestBytes > maxBytes) return false;
        const shardInfo = await lstat(paths.shard).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (shardInfo && (!shardInfo.isDirectory() || shardInfo.isSymbolicLink())) throw new Error("Render cache shard is not a real directory.");
        if (!shardInfo) {
          try { await mkdir(paths.shard, { mode: 0o700 }); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
        }
        const checkedShard = await lstat(paths.shard);
        if (!checkedShard.isDirectory() || checkedShard.isSymbolicLink()) throw new Error("Render cache shard is not a real directory.");
        const tempDirectory = await mkdtemp(join(root, ".tmp-segment-"));
        temporary.add(tempDirectory);
        try {
          await chmod(tempDirectory, 0o700);
          const artifactPath = join(tempDirectory, "artifact");
          const digest = hashAndSizeTransform();
          await pipeline(createReadStream(outputPath), digest.transform, createWriteStream(artifactPath, { flags: "wx", mode: 0o600 }), { signal });
          throwIfAborted(signal);
        if (digest.size() !== info.size || digest.size() + metadataBytes > maxBytes) return false;
          const manifest = {
            version: CACHE_VERSION,
            key,
            artifact: "artifact",
            size: digest.size(),
            sha256: digest.digest(),
            savedAt,
            metadata: cleaned,
          };
          if (digest.size() + Buffer.byteLength(JSON.stringify(manifest)) > maxBytes) return false;
          await syncFile(artifactPath);
          await writeJsonSync(join(tempDirectory, "manifest.json"), manifest);
          await syncDirectory(tempDirectory);
          try {
            await rename(tempDirectory, paths.entry);
            temporary.delete(tempDirectory);
          } catch (error) {
            if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error.code)) throw error;
            const raced = await validateEntry(key, signal).catch(() => null);
            if (raced) return true;
            await rm(paths.entry, { recursive: true, force: true });
            await rename(tempDirectory, paths.entry);
            temporary.delete(tempDirectory);
          }
          await syncDirectory(paths.shard);
          await syncDirectory(root);
          await evict(root, key);
          return true;
        } finally {
          if (temporary.has(tempDirectory)) {
            temporary.delete(tempDirectory);
            await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
          }
        }
      }))));
    },

    /** How full the cache is: { entries, bytes, limitBytes }. */
    usage() {
      return track(async () => {
        const { entries } = await scan(await rootPath(), { anySize: true });
        return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0), limitBytes: maxBytes };
      });
    },

    /**
     * Removes every entry, except those a restore or store is using right now (they stay and are
     * counted in `inUse`), and temporary folders an unfinished store left an hour or more ago.
     * Renders make their entries again.
     * Returns { removed, inUse }.
     */
    clear() {
      return track(async () => {
        const root = await rootPath();
        const { entries, broken, temps } = await scan(root, { anySize: true });
        let removed = 0;
        let kept = 0;
        for (const entry of [...entries, ...broken]) {
          if (inUse.has(entry.key)) { kept += 1; continue; }
          try {
            await rm(entry.path, { recursive: true, force: true });
            if (entries.includes(entry)) removed += 1;
          } catch { kept += 1; }
        }
        for (const temp of temps) {
          if (temporary.has(temp.path) || Date.now() - temp.modified <= STALE_TEMP_MS) continue;
          await rm(temp.path, { recursive: true, force: true }).catch(() => {});
        }
        return { removed, inUse: kept };
      });
    },

    /** Removes each entry whose metadata `test(metadata)` answers true, except those in use. Returns how many it removed. */
    removeWhere(test) {
      return track(async () => {
        const { entries } = await scan(await rootPath(), { anySize: true });
        let removed = 0;
        for (const entry of entries) {
          if (inUse.has(entry.key) || !test(entry.metadata ?? {})) continue;
          try { await rm(entry.path, { recursive: true, force: true }); removed += 1; } catch { /* kept */ }
        }
        return removed;
      });
    },

    /** Sets the most bytes the cache holds and removes the oldest entries at once until it fits. */
    limit(bytes) {
      return track(async () => {
        maxBytes = checkLimit(bytes);
        await evict(await rootPath());
        return maxBytes;
      });
    },

    async close() {
      if (closingPromise) return closingPromise;
      closed = true;
      closingPromise = (async () => {
        await Promise.allSettled([...active]);
        for (const path of temporary) await rm(path, { recursive: true, force: true }).catch(() => {});
        temporary.clear();
      })();
      return closingPromise;
    },
  };
  return api;
}
