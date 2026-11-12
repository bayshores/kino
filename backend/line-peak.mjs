// A line keep_line lifted (layer voiceLevel, engine/keepLine.js) measured in the scene's mix as the
// render plays it: its 0.1 s peaks at the limiter's 192 kHz copy (export.mjs measureMixPeaks,
// audio-levels.mjs readPeakWindows). When the lifted line sends the mix over the master limiter's
// ceiling there (render loudness "off"; the "auto" gain is printed beside it), the line comes down
// by its share of the peak, (ceiling - rest) / (mix - rest) on the measured peaks (the rule
// place_sounds uses), and the mix is measured again. Nothing is drawn or encoded.
import { LIMITER_CEILING_DB, peakOver } from "./audio-levels.mjs";
import { measureMixPeaks, measurePeakWindows, sceneSoundClips } from "./export.mjs";

const linear = (db) => 10 ** (db / 20);
const round1 = (value) => Math.round(value * 10) / 10;

/**
 * The peak of `scene`'s mix from `start` to `end` (scene seconds) with the line on `layerIds` lifted,
 * lowering their voiceLevel (in place) when that peak passes the limiter's ceiling. `directory` holds
 * the volume tracks. Returns {peakDbfs (after), autoDb (the "auto" gain the render adds first, or 0),
 * ceilingDbfs, lowered? {db, from, to, beforeDbfs}, rest? (the rest of the mix alone is over: dBFS)},
 * or null when nothing is heard there.
 */
export async function capLinePeak(scene, { layerIds, start, end, mediaRoot, directory, signal }) {
  const ids = new Set(layerIds);
  const measure = async () => {
    const clips = await sceneSoundClips(scene, { mediaRoot, directory, duration: scene.duration, lead: true, signal });
    const mix = await measureMixPeaks(clips, scene.duration, signal);
    return { clips, peak: mix ? peakOver(mix.windows, start, end) : null, auto: mix?.auto?.gainDb ?? 0 };
  };
  const first = await measure();
  if (first.peak === null) return null;
  const result = { peakDbfs: first.peak, autoDb: first.auto, ceilingDbfs: LIMITER_CEILING_DB };
  // The ceiling with render loudness "off". The "auto" gain is not chased: it is one gain for the whole
  // mix, chosen from the mix itself and held by its peaks (audio-levels.mjs loudnessGain), so a lowered
  // line only raises it (measured: line down 6.8 dB, "auto" up to +8.2 dB). The receipt prints it.
  const ceiling = LIMITER_CEILING_DB;
  if (!(first.peak > ceiling)) return result;
  const layers = scene.layers.filter((layer) => ids.has(layer.id) && Number.isFinite(layer.voiceLevel));
  if (!layers.length) return result;
  const rest = peakOver(await measurePeakWindows(first.clips.filter((clip) => !ids.has(clip.layerId)), Math.min(scene.duration, end + 0.1), signal), start, end) ?? -Infinity;
  const room = linear(ceiling) - linear(rest);
  if (room <= 0) return { ...result, rest };
  const db = Math.floor(200 * Math.log10(room / (linear(first.peak) - linear(rest)))) / 10;
  const from = layers[0].voiceLevel;
  for (const layer of layers) layer.voiceLevel = round1(Math.max(-60, layer.voiceLevel + db));
  const after = await measure();
  return { peakDbfs: after.peak ?? first.peak, autoDb: after.auto, ceilingDbfs: LIMITER_CEILING_DB, lowered: { db, from, to: layers[0].voiceLevel, beforeDbfs: first.peak } };
}

/** The peak in a few words, for keep_line's ways line. */
export function linePeakText(peak) {
  const signed = (value) => `${value > 0 ? "+" : ""}${value}`;
  const auto = peak.autoDb ? ` after the render's "auto" ${signed(peak.autoDb)} dB` : "";
  const lowered = peak.lowered ? `; the lift sent it to ${peak.lowered.beforeDbfs} dBFS, so the line came down ${peak.lowered.db} dB (voiceLevel ${peak.lowered.from} -> ${peak.lowered.to})` : "";
  const rest = peak.rest !== undefined ? `; the rest of the mix alone peaks ${peak.rest} dBFS there` : "";
  return `peak at the line ${peak.peakDbfs} dBFS${auto ? ` (${signed(round1(peak.peakDbfs + peak.autoDb))}${auto})` : ""}, measured; limiter ceiling ${peak.ceilingDbfs} dBFS${lowered}${rest}`;
}
