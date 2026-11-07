// The voice cleanup chain the export puts on spoken lines: a rumble high-pass, a de-esser, a
// gentle compressor and a three-band voice EQ, as FFmpeg filters. It runs BEFORE a line is
// leveled (export.mjs), and the leveling gain is measured on the cleaned sound, so the leveling
// sets the final level of any voice. There is no make-up gain: on a noisy street recording a
// fixed make-up raises the noise between words by as much as it adds.
//
// Ported from ArtCraft FilmCraft, filmcraft/crates/project/src/essential.rs (`EssentialSound::effects`,
// `EQ_PRESETS`, `rumble_cutoff`), MIT OR Apache-2.0, (c) the ArtCraft authors. The rumble cut,
// de-esser and EQ are the original's at its default amount (5 of 10) with the "Balanced Voice"
// preset; the original's de-esser (6 kHz, 12 dB at amount 5) is FFmpeg's deesser with its band cut
// held to 12 dB. The original's compressor (a fixed -24 dB, 3.75:1) took 12 dB off a voice leveled to
// -16 LUFS, so kino keeps its attack and release but sets the threshold from the line's own
// loudness and a gentler ratio, so only the peaks are cut by a few dB.
//
// A layer turns it off with voiceCleanup: false (a voice already mixed and mastered).

// The original's amount for every stage (0..10); 5 is its default.
const AMOUNT = 5;
const linear = (db) => 10 ** (db / 20);
const round = (value, digits = 4) => Number(value.toFixed(digits));

// Balanced Voice: low shelf, mid peak, high shelf, each gain scaled by AMOUNT / 10.
export const BALANCED_VOICE = Object.freeze({ low: [120, -3], mid: [3000, 3], midQ: 1, high: [10000, 2] });

export const VOICE_CHAIN = Object.freeze({
  // rumble_cutoff(a) = 30 + 12a Hz.
  highpass: 30 + AMOUNT * 12,
  // Repair > DeEsser: threshold -6 - 1.2a dB, reduction 2.4a dB.
  deess: { thresholdDb: -6 - AMOUNT * 1.2, reductionDb: AMOUNT * 2.4 },
  // The threshold sits overDb above the line's measured loudness (LUFS), so only peaks are hit;
  // ratio 3 and the original's attack 5 ms and release 120 ms. On the voice fixture the loudest tenth
  // of 50 ms windows lost 2.8 dB on average (3.7 at most), and after leveling the noise between
  // words rose 1.7 dB (0.2 dB with pink noise 20 dB under the voice). Unmeasured lines use -24 dB.
  compressor: { overDb: 7.5, fallbackDb: -12 - AMOUNT * 2.4, ratio: 3, attack: 5, release: 120 },
  eq: {
    low: [BALANCED_VOICE.low[0], BALANCED_VOICE.low[1] * AMOUNT / 10],
    mid: [BALANCED_VOICE.mid[0], BALANCED_VOICE.mid[1] * AMOUNT / 10],
    midQ: BALANCED_VOICE.midQ,
    high: [BALANCED_VOICE.high[0], BALANCED_VOICE.high[1] * AMOUNT / 10],
  },
});

/** Whether the export cleans `layer`'s voice (on unless voiceCleanup is false). */
export const cleansVoice = (layer) => layer?.voiceCleanup !== false;

/**
 * The chain as an FFmpeg filter string for a line measured at `lineLufs` (null: not measured), in
 * the original's processing order (highpass, deesser, dynamics, parametric EQ). FFmpeg's deesser cuts
 * its band by at most `m` (linear), so m is the reduction; at intensity 0.3 it cut 8.7 dB of 6 kHz
 * hiss and left the voice fixture within 0.1 dB (0.5 took 3.3 dB off the whole voice).
 */
export function voiceChainFilters(lineLufs = null, chain = VOICE_CHAIN) {
  const { highpass, deess, compressor, eq } = chain;
  const thresholdDb = Number.isFinite(lineLufs) ? lineLufs + compressor.overDb : compressor.fallbackDb;
  // acompressor's threshold is linear, from 2^-10 to 1.
  const threshold = Math.max(2 ** -10, Math.min(1, linear(thresholdDb)));
  return [
    `highpass=f=${highpass}:p=2`,
    `deesser=i=0.3:m=${round(linear(-deess.reductionDb))}:f=0.5`,
    `acompressor=threshold=${round(threshold, 5)}:ratio=${compressor.ratio}:attack=${compressor.attack}:release=${compressor.release}:knee=2:detection=rms`,
    `lowshelf=f=${eq.low[0]}:g=${eq.low[1]}:t=q:w=0.7071`,
    `equalizer=f=${eq.mid[0]}:t=q:w=${eq.midQ}:g=${eq.mid[1]}`,
    `highshelf=f=${eq.high[0]}:g=${eq.high[1]}:t=q:w=0.7071`,
  ].join(",");
}
