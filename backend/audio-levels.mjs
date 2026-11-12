// Sound levels of exported video. The master limiter keeps the summed sound from clipping, and
// the meter reads integrated loudness (LUFS) and true peak (dBTP) as EBU R128 and ITU-R BS.1770
// define them, with FFmpeg's ebur128 filter.
import { join } from "node:path";
import { BED_VOLUME } from "../engine/mixLevels.js";
import { runExportProcess } from "./export-process.mjs";

const ffmpeg = () => process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";

// The exported sound's true peak stays at or under this.
export const TRUE_PEAK_TARGET_DBTP = -1;
// The limiter starts by holding peaks 1.5 dB under full scale, on a 4× oversampled copy of the
// mix so peaks between samples count too. AAC and Opus encoding can push loud, dense sound 1 to 3
// dB back up, so fitLimiterCeiling lowers the ceiling for them until the encoded sound fits.
export const LIMITER_CEILING_DB = -1.5;
// Each trial encode lowers the ceiling by the encoded sound's excess over -1 dBTP plus this margin.
const CEILING_MARGIN_DB = 0.3;
const TRIAL_ENCODES = 4;
// Platform loudness targets in LUFS (integrated): the render option `loudness` picks one, and
// "off" keeps the mix's own loudness. Every mp4, webm and mov render, drafts too, uses "web" unless told otherwise.
export const LOUDNESS_TARGETS = { web: -14, podcast: -16, broadcast: -23 };
// "auto" (the default) picks web or a song's own level: see mixLead. LOUDNESS_TARGETS stays the fixed ones.
export const LOUDNESS_OPTIONS = ["auto", ...Object.keys(LOUDNESS_TARGETS), "off"];
// Plain gain raises a quiet mix by at most this much, so near silence is not turned into hiss.
const MAX_GAIN_DB = 20;
// The limiter takes peaks down by at most this much. When reaching the target would take more, the
// gain stops there and the file comes out quieter: one gain for the whole mix keeps every line's
// balance, where a moving gain (loudnorm's dynamic mode) would shift lines against each other.
const MAX_LIMITING_DB = 6;
// A trial encode further than this from the target corrects the gain, at most LOUDNESS_TRIALS trials in all.
const TARGET_TOLERANCE_LU = 0.3;
const LOUDNESS_TRIALS = 5;
// A mix whose true peak goes more than this over full scale would have clipped audibly, so the
// limiter works hard there and the export warns.
export const LOUD_MIX_DBTP = 0.5;

/**
 * FFmpeg filters for the end of the mix. Below the ceiling (in dBFS) the sound passes unchanged:
 * level=disabled stops alimiter from raising quiet mixes, and latency=1 removes its 5 ms
 * look-ahead delay so the sound stays in step with the picture.
 */
export function masterLimiter(ceiling = LIMITER_CEILING_DB) {
  const limit = (10 ** (ceiling / 20)).toFixed(4);
  return `aresample=192000,alimiter=limit=${limit}:attack=5:release=50:level=disabled:latency=1,aresample=48000`;
}

// ebur128 adds the running integrated loudness and running true peak to every 100 ms of sound;
// ametadata prints them to standard output as "key=value" lines after each "pts_time" line.
const METER = "ebur128=peak=true:metadata=1,ametadata=mode=print:file=-";

const round1 = (value) => Math.round(value * 10) / 10;
const signed = (value) => `${value > 0 ? "+" : ""}${value}`;

/** Reads the meter's printout: { integratedLufs, loudnessRangeLu, truePeakDbtp, loudestAt } (null when silent). */
export function readLevels(printed) {
  let time = 0, loudness = null, range = null;
  const peaks = [];
  for (const line of String(printed).split("\n")) {
    const frame = line.match(/pts_time:(\S+)/);
    if (frame) time = Number(frame[1]);
    else if (line.startsWith("lavfi.r128.I=")) loudness = Number(line.slice("lavfi.r128.I=".length));
    else if (line.startsWith("lavfi.r128.LRA=")) range = Number(line.slice("lavfi.r128.LRA=".length));
    // true_peak is the loudest channel; older FFmpeg prints only true_peaks_ch0, _ch1 and so on.
    else if (/^lavfi\.r128\.true_peaks?(?:_ch\d+)?=/.test(line)) peaks.push({ time, peak: Number(line.split("=")[1]) });
  }
  const peak = Math.max(0, ...peaks.map((entry) => entry.peak).filter(Number.isFinite));
  // The loudest moment is where the running peak first comes within 0.1 dB of the final peak.
  const loudestAt = peak > 0 ? peaks.find((entry) => entry.peak >= peak * 10 ** (-0.1 / 20)).time : null;
  return {
    // ebur128 reports -70 LUFS, its floor, for silence and for sound shorter than 0.4 s.
    integratedLufs: Number.isFinite(loudness) && loudness > -70 ? round1(loudness) : null,
    // Loudness range (LRA, in LU): how far apart the loud and quiet stretches are. It compares 3 s
    // windows, so under about 4 s of sound FFmpeg's figure means nothing (a steady 3 s tone reads 20 LU).
    loudnessRangeLu: Number.isFinite(range) && loudness > -70 && time >= 3.9 ? round1(range) : null,
    truePeakDbtp: peak > 0 ? round1(20 * Math.log10(peak)) : null,
    loudestAt: loudestAt === null ? null : round1(loudestAt),
  };
}

async function measure(args, signal) {
  const printed = await runExportProcess(ffmpeg(), ["-hide_banner", "-nostdin", "-loglevel", "error", ...args, "-f", "null", "-"], signal);
  return readLevels(printed);
}

/** Levels of the first sound stream in a file. */
export function measureFileLevels(file, signal) {
  return measure(["-i", file, "-map", "0:a:0", "-af", METER], signal);
}

/**
 * Levels of a mix before it is encoded. `inputs` are the FFmpeg input arguments ("-i", file, …,
 * including any volume tracks); `graph` reads them and leaves its last output unnamed.
 */
export function measureMixLevels(inputs, graph, signal) {
  return measure([...inputs, "-filter_complex", `${graph},${METER}`], signal);
}

/**
 * The FFmpeg filter that brings a mix to a loudness target, placed before the master limiter: one
 * plain gain for the whole mix, so the balance between its sounds never changes. `levels` measure
 * the mix (measureMixLevels); `target` is a LOUDNESS_TARGETS key; `correction` (dB) adds to the
 * gain after a trial encode came out off target. The gain stops at 20 dB (`capped`) and where the
 * limiter would take peaks down more than 6 dB (`held`, with `loudestAt`, the peak that holds it).
 * Returns { target, targetLufs, gainDb, correction, capped, held, loudestAt, filter }, or null for
 * "off", an unknown target, or a mix too short or quiet to measure.
 */
export function loudnessGain(levels, target, correction = 0, targetLufs = LOUDNESS_TARGETS[target], why = undefined) {
  if (targetLufs === undefined || levels.integratedLufs === null || levels.truePeakDbtp === null) return null;
  correction = round1(correction);
  const wanted = targetLufs - levels.integratedLufs + correction;
  const headroom = TRUE_PEAK_TARGET_DBTP + MAX_LIMITING_DB - levels.truePeakDbtp;
  const gainDb = round1(Math.min(MAX_GAIN_DB, wanted, headroom));
  const held = headroom < Math.min(MAX_GAIN_DB, wanted);
  return { target, targetLufs, gainDb, correction, capped: wanted > MAX_GAIN_DB, held,
    loudestAt: held ? levels.loudestAt ?? null : null, filter: `volume=${gainDb}dB`, ...(why ? { why } : {}) };
}

// A song-led mix is not turned down under the song it is built on. The thresholds are guesses (nothing
// measured separates them): a song at volume BED_VOLUME or more (the line between a song and a bed,
// engine/mixLevels.js) playing at least half the video, and under half of that time covered by
// leveled speech. Reference edits made around a song sit at -12.9 to -8.8 LUFS (the song's own level),
// a voice-led video at the web's -14 (.scratch/barwave/design/song-level.md).
const SONG_SHARE = 0.5;
const VOICE_SHARE = 0.5;

/**
 * Which loudness target "auto" means for a mix. `songs` are [{seconds, volume, lufs}] (a file's played
 * seconds, its loudest volume, its own loudness over the played spans); `voiceSeconds` the seconds of
 * leveled speech. Returns { target: "song"|"web", targetLufs, why? }: a song-led mix keeps the song's
 * own level when that is over the web's -14, anything else gets -14. `why` appears only when a song plays.
 */
export function mixLead({ duration, songs = [], voiceSeconds = 0 }) {
  const web = LOUDNESS_TARGETS.web;
  const named = songs.filter((song) => song.seconds > 0 && Number.isFinite(song.lufs));
  if (!named.length) return { target: "web", targetLufs: web };
  const led = named.filter((song) => song.volume >= BED_VOLUME);
  const played = led.reduce((sum, song) => sum + song.seconds, 0);
  const seconds = (value) => round1(value);
  if (!led.length) return { target: "web", targetLufs: web, why: `the song is a bed (volume under ${BED_VOLUME})` };
  if (played < duration * SONG_SHARE)
    return { target: "web", targetLufs: web, why: `the song plays ${seconds(played)} of ${seconds(duration)} s` };
  if (voiceSeconds >= played * VOICE_SHARE)
    return { target: "web", targetLufs: web, why: `a voice leads (${seconds(voiceSeconds)} s of words)` };
  const own = round1(Math.max(...led.map((song) => song.lufs)));
  if (own <= web) return { target: "web", targetLufs: web, why: `the song (${own}) is under ${web}` };
  return { target: "song", targetLufs: own, why: "the song's own level, no voice leads" };
}

/**
 * fitLimiterCeiling for a mix brought to a loudness target first (loudnessGain). The limiter gives
 * back less loudness than it is asked for, so while a trial encode is more than 0.3 LU off target
 * the correction grows by the miss divided by how far the last correction actually moved the
 * result, at most 5 trials; a capped or held gain cannot go higher, so it stops there. The trial
 * that landed closest wins. Returns fitLimiterCeiling's result plus `loudness` (the loudnessGain
 * used, or null when the mix keeps its own loudness) and `graph` (the mix with it).
 */
export async function fitLoudness(inputs, graph, levels, target, settings, lead = {}) {
  // `lead` ({ targetLufs, why }) is what "auto" chose (mixLead): its own target, passed on every trial.
  const gain = (correction = 0) => loudnessGain(levels, target, correction, lead.targetLufs ?? LOUDNESS_TARGETS[target], lead.why);
  let loudness = gain();
  if (!loudness) return { ...(await fitLimiterCeiling(inputs, graph, settings)), loudness: null, graph };
  let best = null, previous = null;
  for (let trial = 1; ; trial += 1) {
    const leveled = `${graph},${loudness.filter}`;
    const sound = await fitLimiterCeiling(inputs, leveled, settings);
    const off = sound.integratedLufs === null ? 0 : round1(loudness.targetLufs - sound.integratedLufs);
    if (!best || Math.abs(off) < Math.abs(best.off)) best = { ...sound, loudness, graph: leveled, off };
    if (Math.abs(off) <= TARGET_TOLERANCE_LU || trial === LOUDNESS_TRIALS || ((loudness.capped || loudness.held) && off > 0)) break;
    const step = previous ? loudness.correction - previous.correction : 0;
    const slope = step ? Math.min(1, Math.max(0.25, (previous.off - off) / step)) : 1;
    previous = { correction: loudness.correction, off };
    loudness = gain(loudness.correction + off / slope);
  }
  const { off, ...result } = best;
  // A peak that limited the gain but still let the mix land on target (a loud song's own level
  // sits close to its peaks) is not named as the reason the target was missed.
  if (result.loudness?.held && Math.abs(off) <= TARGET_TOLERANCE_LU) result.loudness = { ...result.loudness, held: false, loudestAt: null };
  return result;
}

/**
 * Finds the limiter ceiling that keeps a mix at or under -1 dBTP once it is encoded. The limited
 * mix (`graph`, as for measureMixLevels) is encoded on its own with the export's sound settings
 * (`codecArgs`, in a `format` file inside `directory`) and measured. While its true peak is over
 * -1 dBTP, the ceiling drops by the excess plus a margin and the sound is encoded again, at most 4
 * times. The encoders give the same result for the same sound, so the export's sound matches the
 * last trial. Returns { ceiling, truePeakDbtp, integratedLufs }: the ceiling in dBFS and the last
 * trial's true peak and loudness.
 */
export async function fitLimiterCeiling(inputs, graph, { codecArgs, format, directory, signal }) {
  const trial = join(directory, `sound-trial.${format}`);
  let ceiling = LIMITER_CEILING_DB;
  for (let attempt = 1; ; attempt += 1) {
    await runExportProcess(ffmpeg(), ["-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      ...inputs, "-filter_complex", `${graph},${masterLimiter(ceiling)}[sound]`,
      "-map", "[sound]", ...codecArgs, "-f", format, trial], signal);
    const { truePeakDbtp, integratedLufs } = await measureFileLevels(trial, signal);
    if (!(truePeakDbtp > TRUE_PEAK_TARGET_DBTP) || attempt === TRIAL_ENCODES) return { ceiling, truePeakDbtp, integratedLufs };
    ceiling -= truePeakDbtp - TRUE_PEAK_TARGET_DBTP + CEILING_MARGIN_DB;
  }
}

/**
 * "-14.1 LUFS (target -14 web), range 4.2 LU, true peak -1.1 dBTP" for the render reply. `loudness`
 * is the export's loudnessGain, or null when the render kept the mix's own loudness.
 */
export function describeLevels({ integratedLufs, loudnessRangeLu = null, truePeakDbtp }, loudness = null) {
  if (truePeakDbtp === null) return "silent";
  const held = loudness?.held ? `, held under by the peak at ${loudness.loudestAt} s: lower that sound to reach it` : "";
  const why = loudness?.why ? `: ${loudness.why}` : "";
  const target = loudness ? ` (target ${loudness.targetLufs} ${loudness.target}${why}${held})` : "";
  const measured = integratedLufs === null ? "too short to measure LUFS" : `${integratedLufs} LUFS${target}`;
  const range = loudnessRangeLu === null ? "" : `, range ${loudnessRangeLu} LU`;
  return `${measured}${range}, true peak ${signed(truePeakDbtp)} dBTP${truePeakDbtp > 0 ? " (clips)" : ""}`;
}

// ---------------------------------------------------------------- limiter places
// Where the mix passes the master limiter, measured without drawing or encoding anything (check's
// "mix:" line, look {mode:"sound"}). ebur128 reads the integrated loudness and true peak as the
// render's own meter does; then each 0.1 s of the mix at 192 kHz (the limiter's own oversampled
// copy) gives its peak, so every loud moment shows, not only the loudest.
export const PEAK_METER = "ebur128=peak=true:metadata=1,aresample=192000,aformat=sample_fmts=dblp,asetnsamples=n=19200," +
  "astats=metadata=1:reset=1:measure_perchannel=Peak_level:measure_overall=none,ametadata=mode=print:file=-";
// Peaks this close (s) are one place: a loud stretch, not one place per 0.1 s.
const PLACE_GAP = 0.3;

/** Reads PEAK_METER's printout: { integratedLufs, truePeakDbtp, windows: [{t, peak}] } (peak in dBFS per 0.1 s). */
export function readPeakWindows(printed) {
  let loudness = null, truePeak = 0, window = null;
  const windows = [];
  for (const line of String(printed).split("\n")) {
    const frame = line.match(/pts_time:(\S+)/);
    if (frame) { window = { t: Math.round(Number(frame[1]) * 100) / 100, peak: -Infinity }; windows.push(window); continue; }
    if (line.startsWith("lavfi.r128.I=")) loudness = Number(line.slice("lavfi.r128.I=".length));
    else if (/^lavfi\.r128\.true_peaks?(?:_ch\d+)?=/.test(line)) truePeak = Math.max(truePeak, Number(line.split("=")[1]) || 0);
    else if (window && /^lavfi\.astats\.\d+\.Peak_level=/.test(line)) {
      const peak = Number(line.split("=")[1]);
      if (Number.isFinite(peak)) window.peak = Math.max(window.peak, peak);
    }
  }
  return {
    integratedLufs: Number.isFinite(loudness) && loudness > -70 ? round1(loudness) : null,
    truePeakDbtp: truePeak > 0 ? round1(20 * Math.log10(truePeak)) : null,
    windows: windows.filter((entry) => Number.isFinite(entry.peak)),
  };
}

/**
 * Every place where the mix's peak passes the limiter's ceiling, in time order: [{at, from, to,
 * peakDbtp, overDb, factor}]. `at` is its loudest 0.1 s, `overDb` how far the limiter turns it
 * down there, `factor` the volume multiplier for the sounds playing there that brings the peak to
 * the ceiling (the limiter then does nothing).
 */
export function limiterPlaces(windows, { ceiling = LIMITER_CEILING_DB } = {}) {
  const places = [];
  for (const window of windows) {
    if (!(window.peak > ceiling)) continue;
    const last = places.at(-1);
    if (last && window.t - last.at(-1).t - 0.1 <= PLACE_GAP) last.push(window);
    else places.push([window]);
  }
  return places.map((place) => {
    const peak = Math.max(...place.map((window) => window.peak));
    // Its time is where it first comes within 0.1 dB of its peak, as the render's warning names it.
    const at = place.find((window) => window.peak >= peak - 0.1).t;
    return { at: round1(at), from: round1(place[0].t), to: round1(place.at(-1).t + 0.1), peakDbtp: round1(peak),
      overDb: round1(peak - ceiling), factor: Math.floor(100 * 10 ** ((ceiling - peak) / 20)) / 100 };
  });
}

const placeText = (place) => {
  const names = place.playing ?? [];
  const shown = names.slice(0, 4).map((clip) => `${String(clip.name).slice(0, 24)} ${clip.volume}`);
  if (names.length > 4) shown.push(`${names.length - 4} more`);
  return `${place.at} s ${signed(place.peakDbtp)} dBTP, ${place.overDb} dB over${shown.length ? ` (${shown.join(", ")})` : ""} x${place.factor}`;
};

/**
 * The mix in one line: "mix: -10.3 LUFS, true peak +4.1 dBTP; the limiter works at 3 places, ...".
 * `mix` is { integratedLufs, truePeakDbtp, places } (places with `playing` [{name, volume}]);
 * `limit` how many of the worst places are named, `tail` what follows them.
 */
export function describeMixPeaks(mix, { limit = 3, tail = "", label = "mix" } = {}) {
  const level = `${label}: ${mix.integratedLufs === null ? "too short to measure LUFS" : `${mix.integratedLufs} LUFS`}, true peak ${mix.truePeakDbtp === null ? "silent" : `${signed(mix.truePeakDbtp)} dBTP`} with render loudness "off"`;
  // What the default "auto" target's gain does to the same peaks (measureMixPeaks `auto`).
  const auto = mix.auto;
  const autoText = auto ? `; loudness "auto" (the render default, target ${auto.targetLufs} ${auto.target}) adds ${signed(auto.gainDb)} dB first${auto.held ? " (held by the peaks)" : ""}, then the limiter ` +
    (auto.places ? `works at ${auto.places} ${auto.places === 1 ? "place" : "places"}, most ${auto.worst.overDb} dB at ${auto.worst.at} s` : "never works") : "";
  if (!mix.places.length) return `${level}; the limiter (ceiling ${LIMITER_CEILING_DB} dBFS) never works${autoText}`;
  // All of them in time order when they fit, else the worst first.
  const all = limit >= mix.places.length;
  const shown = all ? mix.places : [...mix.places].sort((a, b) => b.overDb - a.overDb || a.at - b.at).slice(0, limit);
  return `${level}; the limiter (ceiling ${LIMITER_CEILING_DB} dBFS) works at ${mix.places.length} ${mix.places.length === 1 ? "place" : "places"}${all ? "" : `, worst ${shown.length}`}: ` +
    `${shown.map(placeText).join(" · ")} (xN: multiply the volumes playing there by N to clear it)${autoText}${all ? "" : tail}`;
}

/**
 * What check {fix:"auto"} did to the mix, from measureMixPeaks before and after it: "mix fix: the
 * limiter works at 9 -> 0 places (most 6.5 -> 0 dB over); -12.9 -> -13.4 LUFS, true peak +0.8 ->
 * -1.6 dBTP with loudness "off"; "auto" adds +4.2 -> +5.1 dB, then the limiter works at 82 -> 30 places".
 */
export function describeMixFix(before, after) {
  const most = (mix) => Math.max(0, ...mix.places.map((place) => place.overDb));
  const level = (mix) => (mix.integratedLufs === null ? "too short" : mix.integratedLufs);
  const peak = (mix) => (mix.truePeakDbtp === null ? "silent" : signed(mix.truePeakDbtp));
  const auto = before.auto && after.auto
    ? `; "auto" adds ${signed(before.auto.gainDb)} -> ${signed(after.auto.gainDb)} dB, then the limiter works at ${before.auto.places} -> ${after.auto.places} places` : "";
  return `mix fix: the limiter works at ${before.places.length} -> ${after.places.length} places (most ${most(before)} -> ${most(after)} dB over); ` +
    `${level(before)} -> ${level(after)} LUFS, true peak ${peak(before)} -> ${peak(after)} dBTP with loudness "off"${auto}`;
}

/**
 * The warning for a mix that would have clipped without the limiter, or null. `levels` measure the
 * mix before the limiter; `sound` is fitLimiterCeiling's result. `clips` are the sounds in the mix
 * ({ name, volume, start, end }); the warning names those playing at the loudest moment.
 */
export function loudMixWarning(levels, clips, sound) {
  if (!(levels.truePeakDbtp > LOUD_MIX_DBTP)) return null;
  const at = levels.loudestAt;
  const playing = clips.filter((clip) => clip.start < at + 0.1 && clip.end > at)
    .map((clip) => `${clip.name} at volume ${clip.volume}`);
  const names = playing.length > 6 ? [...playing.slice(0, 6), `${playing.length - 6} more`] : playing;
  const turnedDown = round1(levels.truePeakDbtp - sound.ceiling);
  // Encoding can still clip when even the last trial's ceiling was not low enough.
  const outcome = sound.truePeakDbtp > 0
    ? `The master limiter turned it down about ${turnedDown} dB there, but the encoded sound still clips at ${signed(sound.truePeakDbtp)} dBTP.`
    : `The master limiter turned it down about ${turnedDown} dB there to stop clipping.`;
  // Lowering them this much brings the mix's peak to about -1 dBTP, so the limiter has little left to do.
  const lower = Math.ceil(levels.truePeakDbtp + 1);
  return {
    code: "audio-limited",
    message: `The sound mix peaked at ${signed(levels.truePeakDbtp)} dBTP at ${at} s. ${outcome} ` +
      `${names.length ? `Playing then: ${names.join(", ")}. Lower their volumes` : "Lower the volumes playing there"} ` +
      `by about ${lower} dB (multiply by ${(10 ** (-lower / 20)).toFixed(2)}).`,
  };
}
