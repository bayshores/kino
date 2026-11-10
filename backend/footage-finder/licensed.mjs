// Licensed footage from Wikimedia Commons: openly licensed video clips (CC0, CC BY, CC BY-SA,
// public domain) for b-roll. No anime there; YouTube (search.mjs) covers that.
//
// One search asks the Commons API (https://commons.wikimedia.org/w/api.php) for video files that
// match the words, with each file's license and creator (extmetadata) and the copies Commons made
// of it (prop=videoinfo, viprop=derivatives). kino only reads those copies: a 360p one for the
// scan and one of 1080p at most for import, so it never opens an original taller than 1080 (Commons
// keeps 4K originals). The short side counts, so a vertical 1080x1920 clip is 1080p too.
//
// Only reached behind the person's web search switch (Settings, sounds.search), because the
// search words leave this computer. Requests carry kino's own name; files come only from
// wikimedia.org hosts, with every redirect checked (web-files.mjs). Answers are cached a day.
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { licenseFromUrl, licenseName } from "../soundtrack.mjs";
import { createWebCache } from "../web-cache.mjs";
import { fetchChecked, KINO_USER_AGENT } from "../web-files.mjs";

const API = "https://commons.wikimedia.org/w/api.php";
const FILE_HOSTS = ["wikimedia.org"];
export const COMMONS_LIMITS = Object.freeze({ results: 10, asked: 20, words: 120, minSeconds: 5, maxSeconds: 3 * 60 * 60, scanHeight: 360, importHeight: 1080, scanMegabytes: 200, importMegabytes: 1500, searchMs: 20000, downloadMs: 10 * 60 * 1000, cacheMs: 24 * 60 * 60 * 1000 });
// Licenses that allow changes and commercial use (a clip cut into an edit is a change).
const USABLE = new Set(["cc0", "by", "by-sa", "pdm"]);
// Among copies of the same size: H.264 MP4 decodes fastest, then VP9, then the rest.
const TYPE_ORDER = [/^video\/mp4/, /vp9/, /^video\/webm/];

export class LicensedFootageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const clean = (value, fallback) => String(value ?? "").replace(/<[^>]*>/g, " ")
  .replace(/&(amp|quot|#39|apos|lt|gt|nbsp);/g, (_, name) => ({ amp: "&", quot: "\"", "#39": "'", apos: "'", lt: "<", gt: ">", nbsp: " " })[name])
  .replace(/\s+/g, " ").trim().slice(0, 120) || fallback;

/**
 * A Commons file's license from its extmetadata, as {license, licenseUrl}, when it allows changes
 * and commercial use (CC0, CC BY, CC BY-SA, public domain); null for NC, ND, GFDL-only or unknown.
 */
export function commonsLicense(extmetadata) {
  const short = clean(extmetadata?.LicenseShortName?.value, "");
  const url = clean(extmetadata?.LicenseUrl?.value, "") || null;
  if (/\b(nc|nd)\b|non-?commercial|no-?deriv/i.test(short)) return null;
  const fromUrl = licenseFromUrl(url);
  if (fromUrl) return USABLE.has(fromUrl.license) ? { license: licenseName(fromUrl.license, fromUrl.version), licenseUrl: url } : null;
  if (/^(cc0|cc-zero)\b/i.test(short)) return { license: "CC0 1.0", licenseUrl: url };
  if (/^public domain\b|^pd\b/i.test(short)) return { license: "Public domain", licenseUrl: url };
  if (/^cc[ -]by(-sa)?(?:[ -][\d.]+)?$/i.test(short)) return { license: short.toUpperCase().replace(/-(?=\d)/, " "), licenseUrl: url };
  return null;
}

/**
 * The copies kino reads from one file's videoinfo: scan (360p, else the smallest above it) and
 * import (the largest of 1080p at most). Copies come only from derivatives; any copy (the
 * original among them) whose short side is over 1080 is never picked. null when none fits.
 */
export function commonsFiles(info) {
  const copies = (Array.isArray(info?.derivatives) ? info.derivatives : []).map((copy) => {
    const width = Number(copy?.width) || 0;
    const height = Number(copy?.height) || 0;
    const type = String(copy?.type ?? "");
    if (typeof copy?.src !== "string" || !width || !height || !type.startsWith("video/")) return null;
    const short = Math.min(width, height);
    if (short > COMMONS_LIMITS.importHeight) return null;
    const rank = TYPE_ORDER.findIndex((pattern) => pattern.test(type));
    return { url: copy.src, width, height, short, type: type.split(";")[0], rank: rank < 0 ? TYPE_ORDER.length : rank };
  }).filter(Boolean);
  if (!copies.length) return null;
  const pick = (list) => [...list].sort((a, b) => a.rank - b.rank)[0];
  const sized = (short) => copies.filter((copy) => copy.short === short);
  const largest = Math.max(...copies.map((copy) => copy.short));
  const small = copies.filter((copy) => copy.short <= COMMONS_LIMITS.scanHeight).map((copy) => copy.short);
  const scanShort = small.length ? Math.max(...small) : Math.min(...copies.map((copy) => copy.short));
  const plain = ({ url, width, height, type }) => ({ url, width, height, type });
  return { scan: plain(pick(sized(scanShort))), import: plain(pick(sized(largest))) };
}

/** The Commons search answer (formatversion 2) as candidates, in Commons' order, usable ones only. */
export function parseCommonsSearch(body) {
  const pages = Array.isArray(body?.query?.pages) ? body.query.pages : [];
  return [...pages].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map((page) => {
    const info = page?.videoinfo?.[0];
    if (!Number.isInteger(page?.pageid) || !info || String(info.mediatype ?? "").toUpperCase() !== "VIDEO") return null;
    const seconds = Math.round((Number(info.duration) || 0) * 10) / 10;
    if (seconds < COMMONS_LIMITS.minSeconds || seconds > COMMONS_LIMITS.maxSeconds) return null;
    const license = commonsLicense(info.extmetadata);
    if (!license) return null;
    const files = commonsFiles(info);
    if (!files) return null;
    const title = clean(String(page.title ?? "").replace(/^File:/, "").replace(/\.[a-z0-9]{2,4}$/i, ""), "untitled clip");
    const creator = clean(info.extmetadata?.Artist?.value, "unknown");
    const pageUrl = typeof info.descriptionurl === "string" ? info.descriptionurl : null;
    return {
      id: `clip:commons-${page.pageid}`, source: "commons", title, creator, seconds,
      width: Number(info.width) || null, height: Number(info.height) || null, page: pageUrl, ...license, files,
      credit: `"${title}" by ${creator}${pageUrl ? ` (${pageUrl})` : ""}, ${license.license}${license.licenseUrl ? ` (${license.licenseUrl})` : ""}`,
    };
  }).filter(Boolean).slice(0, COMMONS_LIMITS.results);
}

/**
 * deps: enabled() (the web search switch), directory (cache folder; optional), fetch (tests pass
 * a stub), api, now. Returns {search(words), download(candidate, folder, {use}), fileUrl(candidate, use)}.
 */
export function createCommonsSource({ enabled, directory, fetch = globalThis.fetch, api = API, now = Date.now }) {
  const cache = directory ? createWebCache({ directory, ttlMs: COMMONS_LIMITS.cacheMs, now }) : null;
  const refuse = (host) => new LicensedFootageError("refused", `The clip's file is on ${host}, which kino does not download from.`);
  const on = () => {
    if (!enabled()) throw new LicensedFootageError("web_search_off", "Commons needs the person's web search switch in kino Settings. YouTube still works.");
  };

  async function ask(words) {
    const params = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", generator: "search", gsrnamespace: "6",
      gsrsearch: `${words} filetype:video`, gsrlimit: String(COMMONS_LIMITS.asked), prop: "videoinfo",
      viprop: "url|size|mediatype|extmetadata|derivatives", viextmetadatafilter: "LicenseShortName|LicenseUrl|Artist",
    });
    let response;
    try { response = await fetch(`${api}?${params}`, { headers: { "user-agent": KINO_USER_AGENT }, signal: AbortSignal.timeout(COMMONS_LIMITS.searchMs) }); }
    catch (error) { throw new LicensedFootageError("failed", `Commons could not be reached (${error?.name === "TimeoutError" ? "no answer" : error.message}).`); }
    if (response.status === 429) throw new LicensedFootageError("rate_limited", "Commons limits searches; try again in a minute.");
    if (!response.ok) throw new LicensedFootageError("failed", `Commons answered ${response.status}.`);
    let body;
    try { body = await response.json(); } catch { throw new LicensedFootageError("failed", "Commons did not answer with JSON."); }
    if (body?.error) throw new LicensedFootageError("failed", `Commons search failed (${clean(body.error.info ?? body.error.code, "error").slice(0, 80)}).`);
    return parseCommonsSearch(body);
  }

  async function search(words) {
    on();
    const asked = clean(words, "").slice(0, COMMONS_LIMITS.words);
    if (!asked) throw new LicensedFootageError("bad_input", "search needs words, e.g. \"ocean waves at sunset\".");
    return cache ? cache.cached(`commons\n${asked.toLowerCase()}`, () => ask(asked)) : ask(asked);
  }

  // Only "scan" and "import" are copies; any other value (say "../x") could name a file outside the folder.
  function copyKind(use) {
    if (use === "scan" || use === "import") return use;
    throw new LicensedFootageError("bad_input", `use is "scan" or "import", not ${JSON.stringify(String(use))}.`);
  }

  function fileUrl(candidate, use = "scan") {
    const kind = copyKind(use);
    const file = candidate?.files?.[kind];
    if (!file?.url) throw new LicensedFootageError("bad_input", `${candidate?.id ?? "This clip"} has no ${kind} copy.`);
    return file.url;
  }

  /** Saves the scan (360p) or import (1080p at most) copy into `folder`; answers the file path. */
  async function download(candidate, folder, { use = "scan", signal } = {}) {
    on();
    const kind = copyKind(use);
    const { response } = await fetchChecked(fileUrl(candidate, kind), {
      fetch, hosts: FILE_HOSTS, refuse, signal: signal ?? AbortSignal.timeout(COMMONS_LIMITS.downloadMs),
    });
    if (!response.ok || !response.body) throw new LicensedFootageError("failed", `Commons answered ${response.status} for ${candidate.id}.`);
    const megabytes = kind === "import" ? COMMONS_LIMITS.importMegabytes : COMMONS_LIMITS.scanMegabytes;
    const limit = megabytes * 1024 * 1024;
    const extension = /mp4/.test(candidate.files[kind].type) ? "mp4" : "webm";
    const file = path.join(folder, `${kind}.${extension}`);
    let size = 0;
    const counted = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        done(size > limit ? new LicensedFootageError("refused", `${candidate.id} is over ${megabytes} MB.`) : null, chunk);
      },
    });
    try { await pipeline(Readable.fromWeb(response.body), counted, createWriteStream(file, { mode: 0o600 })); }
    catch (error) { await rm(file, { force: true }); throw error; }
    return file;
  }

  return { search, download, fileUrl };
}
