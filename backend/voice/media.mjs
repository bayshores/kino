// Voice isolation for the edit op isolate_voice (backend/agent/service.mjs). It turns a media
// file's voice or background stem (isolate.mjs) into a new file in kino's media library, so a
// layer plays it like any imported file. Saving, history undo, exports and the dashboard mix then
// work without anything new: they only see a layer whose src points at another library file.
//
//   audio file → "<name> (voice).m4a": the stem as lossless FLAC in an MP4 file (audio/mp4)
//   MP4 video  → "<name> (voice).mp4": the same picture, copied as it is (not encoded again),
//                with the stem as its sound (FLAC)
//   WebM video → "<name> (voice).webm": the same picture with the stem as Opus sound (WebM
//                has no FLAC)
//
// A file's sound can start a little later than the file (after its picture, for example). The
// stems start with the sound, so silence of that length goes in front: a time in the new file is
// the same moment as that time in the old one, and a layer's Play settings stay right. (The
// export, and the dashboard mix, which is the export's mix, start such a sound at its first
// sample when the Play offset is before it, so the old file was heard that much early there; the
// new file is heard in step with its picture. Most camera files have no gap.)
//
// Which library file was made from which stem is kept in the stem's cache folder (media.json), so
// running isolate_voice again on the same file reuses the same library file while it is still there.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { removeLeftoverWork } from "../leftover-work.mjs";
import { basename, dirname, extname, join } from "node:path";
import { runMediaTool } from "../media-probe.mjs";
import { isolateVoice, voiceEngines } from "./isolate.mjs";

const SAMPLE_RATE = 48000;
// How each kind of output is written: its file extension, MIME type and FFmpeg sound settings.
const FORMS = {
  m4a: { mime: "audio/mp4", sound: ["-c:a", "flac", "-sample_fmt", "s32"], muxer: ["-movflags", "+faststart", "-f", "mp4"] },
  mp4: { mime: "video/mp4", sound: ["-c:a", "flac", "-sample_fmt", "s32"], muxer: ["-movflags", "+faststart", "-f", "mp4"] },
  webm: { mime: "video/webm", sound: ["-c:a", "libopus", "-b:a", "192k"], muxer: ["-f", "webm"] },
};

/** "Interview.mp4" → "Interview": the name the new files are named after. */
export function mediaBaseName(name) {
  const text = String(name ?? "").trim() || "sound";
  const extension = extname(text);
  return extension && extension.length <= 5 ? text.slice(0, -extension.length) || text : text;
}

/**
 * How many seconds after the start of `file` its first sound track starts (0 or more). The stems
 * start with the sound, so this much silence is put in front of them.
 */
export async function soundLead(file, signal) {
  const text = await runMediaTool("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries",
    "stream=start_time:format=start_time", "-of", "json", file], { signal });
  const probe = JSON.parse(text);
  const sound = Number(probe.streams?.[0]?.start_time);
  const start = Number(probe.format?.start_time);
  if (!Number.isFinite(sound)) return 0;
  const lead = sound - (Number.isFinite(start) ? start : 0);
  // Less than half a millisecond is rounding in the container's clock.
  return lead > 0.0005 ? lead : 0;
}

/**
 * Makes library media from voice stems. Options:
 *   mediaRoot  kino's media folder (to check that a remembered file is still there)
 *   cacheDir   the stem cache (isolate.mjs); media.json files go in its stem folders
 *   modelDir   the DPDFNet model folder
 *   addMedia   async (file, { name, mime }) → the new media record ({ id, src, name, mime, … });
 *              it moves `file` into the library (backend/index.mjs)
 *   download   false stops the one-time DPDFNet model download
 */
export function createVoiceMedia({ mediaRoot, cacheDir, modelDir, addMedia, download = true }) {
  // Work folders a server stopped part-way left in the stem cache (isolate.mjs ".work-…", output
  // ".media-…") and nothing has touched for an hour.
  removeLeftoverWork(cacheDir);
  // One job per output at a time, so two edits at once don't make the same file twice.
  const making = new Map();

  async function remembered(folder) {
    try { return JSON.parse(await readFile(join(folder, "media.json"), "utf8")); } catch { return {}; }
  }

  async function libraryRecord(id) {
    if (typeof id !== "string" || !/^[a-f0-9-]+\.[a-z0-9]+$/.test(id) || !existsSync(join(mediaRoot, id))) return null;
    try {
      const record = JSON.parse(await readFile(join(mediaRoot, `${id}.json`), "utf8"));
      return record.id === id ? record : null;
    } catch { return null; }
  }

  // The library file for one stem in one form, made the first time.
  async function output({ folder, stem, form, file, name, signal }) {
    const slot = `${stem}.${form}`;
    const reused = await libraryRecord((await remembered(folder))[slot]);
    if (reused) return { record: reused, made: false };
    await mkdir(cacheDir, { recursive: true });
    const work = await mkdtemp(join(cacheDir, ".media-"));
    try {
      const target = join(work, `out.${form}`);
      const lead = await soundLead(file, signal);
      const delay = lead > 0 ? ["-af", `adelay=delays=${Math.round(lead * SAMPLE_RATE)}S:all=1`] : [];
      const { sound, muxer, mime } = FORMS[form];
      const stemFile = join(folder, `${stem}.flac`);
      const inputs = form === "m4a"
        ? ["-i", stemFile, "-map", "0:a:0"]
        // The picture is copied as it is; only the sound is new. 0:V is the first real video
        // track (not a cover picture).
        : ["-i", file, "-i", stemFile, "-map", "0:V:0", "-map", "1:a:0", "-c:v", "copy", "-map_metadata", "0"];
      await runMediaTool("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", ...inputs, ...delay, ...sound, ...muxer, target], { signal });
      // What kino knows of the source that still holds (derived-media.mjs): a video keeps its
      // picture; both stems keep the clip's language; the voice keeps its words and their times.
      const holds = { picture: form !== "m4a", language: true, words: stem === "voice" };
      const record = await addMedia(target, { name: `${mediaBaseName(name)} (${stem}).${form}`, mime, from: { id: basename(file), holds } });
      // Read again just before writing: another stem of this folder may have been added meanwhile.
      const list = { ...(await remembered(folder)), [slot]: record.id };
      // Its own temporary name: the voice and background stems of one file can finish at once.
      const temporary = join(folder, `.media.json.${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`);
      await rename(temporary, join(folder, "media.json"));
      return { record, made: true };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  function once(key, job) {
    if (!making.has(key)) making.set(key, job().finally(() => making.delete(key)));
    return making.get(key);
  }

  /**
   * Splits the sound of library file `file` (named `name`, of type `mime`) and returns the media
   * the layer needs: { voice?, background?, engine, seconds, cached, note }. keep "voice" or
   * "background" gives that stem in the file's own kind (a video stays a video); "both" gives the
   * voice in the file's kind and the background as sound only (.m4a), for a new audio layer.
   * `cached` is true when the stems and every library file already existed.
   */
  async function make({ file, name, mime, keep = "voice", engine = "auto", amount = 1, signal }) {
    const started = performance.now();
    const result = await isolateVoice({ source: file, engine, amount, keep: "voice", cacheDir, modelDir, download, signal });
    const folder = dirname(result.voice);
    const own = mime === "video/mp4" ? "mp4" : mime === "video/webm" ? "webm" : "m4a";
    const wanted = keep === "both" ? [["voice", own], ["background", "m4a"]] : [[keep, own]];
    const found = {};
    const madeIds = [];
    for (const [stem, form] of wanted) {
      const job = await once(`${folder}/${stem}.${form}`, () => output({ folder, stem, form, file, name, signal }));
      found[stem] = job.record;
      if (job.made) madeIds.push(job.record.id);
    }
    // stems: the voice and background stem files (FLAC in the stem cache), for measuring.
    return { ...found, engine: result.engine, seconds: (performance.now() - started) / 1000,
      cached: result.cached && !madeIds.length, note: result.note, madeIds, stems: { voice: result.voice, background: result.background } };
  }

  // engines(): which engines this computer can use (for the next step a refusal suggests).
  return { make, engines: () => voiceEngines({ modelDir }), downloads: download };
}
