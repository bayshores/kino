// What compose {footage} knows about the material before it plans (engine/footage/plan.js): each
// clip's media record, its measures (faces, motion, text: backend/footage/analyze.mjs), its
// words (the transcript of its sound, made on this computer: backend/speech/transcribe.mjs), and
// the music's beats and loudness. Everything is measured once and kept beside the file.
//
// A sound file given in `footage` plays with the video of the same length (a phone's video and
// its separately recorded sound): it is paired by duration (within 0.15 s), not by name.
import path from "node:path";
import { existsSync } from "node:fs";
import { isRecord } from "../../engine/numbers.js";

const kindOf = (record) => String(record?.mime ?? "").split("/")[0];
const bare = (name) => String(name ?? "").toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "");
export const FOOTAGE_FIELDS = ["footage", "music", "voice", "treatment", "pace", "accents", "title", "end"];
export const MAX_FOOTAGE = 12;

/** Reads the footage list: [{media, in?, out?}] (a bare string is {media}). Throws a plain message. */
export function readFootageList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FOOTAGE) throw new Error(`footage is a list of 1 to ${MAX_FOOTAGE} imported clips: ["walk.mp4", {media:"talk.mp4", in:12, out:40}, …].`);
  return value.map((entry, index) => {
    const item = typeof entry === "string" ? { media: entry } : entry;
    if (!isRecord(item) || typeof item.media !== "string" || !item.media.trim()) throw new Error(`footage[${index}] is a media name or id, or {media, in?, out?}.`);
    const extra = Object.keys(item).filter((key) => !["media", "in", "out"].includes(key));
    if (extra.length) throw new Error(`footage[${index}] takes media, in and out, not ${extra.join(", ")}.`);
    for (const key of ["in", "out"]) if (item[key] !== undefined && (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0)) throw new Error(`footage[${index}].${key} is seconds into the file.`);
    if (item.in !== undefined && item.out !== undefined && item.out - item.in < 1) throw new Error(`footage[${index}]: out must be at least 1 s after in.`);
    return { media: item.media.trim(), ...(item.in !== undefined ? { in: item.in } : {}), ...(item.out !== undefined ? { out: item.out } : {}) };
  });
}

/**
 * The fact gatherer. deps: listMedia, mediaRoot, transcripts ({get}), beatAnalysis ({get}),
 * footageCache ({video, sound}), songShapes ({get}: a song's sections and seams, optional).
 * facts(document, {footage, music, voice}) resolves to {clips,
 * music, voice, notes}; notes say what could not be measured and why.
 */
export function createFootageFacts({ listMedia, mediaRoot, transcripts, beatAnalysis, footageCache, songShapes = null }) {
  const fileOf = (record) => {
    const file = mediaRoot ? path.join(mediaRoot, record.id) : null;
    if (!file || !existsSync(file)) throw new Error(`${record.name} is not in kino's media folder; import it again.`);
    return file;
  };
  async function finder() {
    const list = (await listMedia()).filter((item) => ["video", "audio", "image"].includes(kindOf(item)));
    return (ref, what) => {
      const text = String(ref).trim();
      const found = list.find((item) => item.id === text || item.src === text || `/api/media/${item.id}` === text)
        ?? list.find((item) => String(item.name ?? "").toLowerCase() === text.toLowerCase())
        ?? list.find((item) => bare(item.name) === bare(text));
      if (!found) {
        const names = list.map((item) => item.name).slice(0, 6).join(", ");
        throw new Error(`${what}: no imported media "${text}". Import it first (project {action:"import", file}); imported: ${names || "none"}.`);
      }
      return found;
    };
  }
  // The words of a sound file, heard with the names of `document`'s brief (or the transcript a cut
  // voice of it was cut on: service.mjs transcripts).
  async function words(file, notes, name, document, src) {
    try { return (await transcripts.get(file, document, { src })).words ?? []; }
    catch (error) {
      notes.push(`no words for ${name}: ${String(error.message).split(". ")[0]}`);
      return null;
    }
  }
  return async function facts(document, { footage, music, voice }) {
    const notes = [];
    const find = await finder();
    const items = footage.map((entry) => ({ ...entry, record: find(entry.media, "footage") }));
    const sounds = items.filter((item) => kindOf(item.record) === "audio");
    const pictures = items.filter((item) => kindOf(item.record) !== "audio");
    if (!pictures.length) throw new Error("footage needs at least one video or picture; a sound alone goes in voice or music.");
    const clips = [];
    for (const [index, item] of pictures.entries()) {
      const record = item.record;
      const file = fileOf(record);
      const picture = kindOf(record) === "image";
      const duration = picture ? 4 : Number(record.duration) || 0;
      if (!picture && !(duration > 0)) throw new Error(`${record.name} has no known length; import it again.`);
      const clip = {
        key: `c${index + 1}`, name: record.name, mediaId: record.id, src: record.src ?? `/api/media/${record.id}`, kind: picture ? "picture" : "camera",
        width: record.width || 1920, height: record.height || 1080, duration, in: Math.min(item.in ?? 0, Math.max(0, duration - 1)), out: Math.min(item.out ?? duration, duration),
        shots: Array.isArray(record.shots) ? record.shots : null, words: null, samples: null, sound: null,
      };
      if (!picture) {
        try { clip.samples = (await footageCache.video(file, { width: clip.width, height: clip.height, duration })).samples; }
        catch (error) { notes.push(`${record.name} was not measured (${error.message}); framing and moments use the middle of the picture`); }
        // Its sound: its own track, or a sound file of the same length given in footage.
        const paired = sounds.find((sound) => !sound.used && Math.abs((Number(sound.record.duration) || 0) - duration) <= 0.15);
        if (paired) paired.used = true;
        const soundRecord = record.hasAudio ? record : paired?.record ?? null;
        if (soundRecord) {
          const soundFile = fileOf(soundRecord);
          let loud = null;
          try { loud = (await footageCache.sound(soundFile)).loud; } catch { /* a silent track is not heard */ }
          if (loud !== null && loud > -55) {
            clip.sound = { src: soundRecord.src ?? `/api/media/${soundRecord.id}`, own: soundRecord === record, duration: Number(soundRecord.duration) || duration, loud, name: soundRecord.name };
            clip.words = await words(soundFile, notes, soundRecord.name, document, clip.sound.src);
          }
          if (paired) notes.push(`${paired.record.name} plays with ${record.name} (same length)`);
        }
      }
      clips.push(clip);
    }
    for (const sound of sounds.filter((entry) => !entry.used)) notes.push(`${sound.record.name} matched no clip's length, so it is not used; give it as voice (a voice-over) or music`);
    let musicFacts = null;
    if (music !== undefined && music !== null) {
      const record = find(music, "music");
      const file = fileOf(record);
      const [analysis, loudness] = await Promise.all([beatAnalysis.get(file).catch((error) => { notes.push(`the music's beat could not be found (${error.message}); cuts follow the shots`); return null; }), footageCache.sound(file)]);
      musicFacts = { src: record.src ?? `/api/media/${record.id}`, name: record.name, duration: Number(record.duration) || analysis?.duration || 0, analysis, loud: loudness.loud, curve: loudness.curve };
      // The song's sections and seams (the .song file fit_music keeps): cuts lock to them (plan.js).
      if (songShapes && analysis?.bpm) {
        const shape = await songShapes.get(file, analysis.bpm).catch((error) => { notes.push(`the music's sections could not be read (${error.message}); cuts follow the beat`); return null; });
        if (shape) musicFacts.shape = { sections: shape.sections ?? [], seams: shape.seams ?? [] };
      }
      if (analysis && !analysis.bpm) notes.push(`no steady beat in ${record.name}; cuts follow the shots`);
    }
    let voiceFacts = null;
    if (voice !== undefined && voice !== null) {
      const record = find(voice, "voice");
      const file = fileOf(record);
      const loudness = await footageCache.sound(file);
      voiceFacts = { src: record.src ?? `/api/media/${record.id}`, name: record.name, duration: Number(record.duration) || 0, loud: loudness.loud };
      voiceFacts.words = await words(file, notes, record.name, document, voiceFacts.src);
    }
    return { clips, music: musicFacts, voice: voiceFacts, notes };
  };
}
