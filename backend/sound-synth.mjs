// Everyday action sounds kino makes itself, in code: no file to download, the same bytes every
// time. They join the built-in sound library (sound-library.mjs): footsteps and cloth
// rustling (a door is already in the downloaded catalog). Each is mono 16-bit at 44.1 kHz, under 0.4 s (so the library reads its level by its
// sample peak, as it does for the other short sounds), and peaks at about -1.5 dBFS.
//
// - synthEntries(): the catalog entries ({id, words, seconds, lufs, peak, synth}).
// - synthWav(name): the WAV bytes of one.

const RATE = 44100;
const TARGET_PEAK = 0.85;

// mulberry32: a small seeded noise, so a sound is the same on every computer.
function noise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 31 - 1;
  };
}

// A thud: a sine that falls from `high` to `low` Hz and dies away, starting at `start` seconds.
function thud(out, { start = 0, high, low, fall, decay, gain }) {
  let phase = 0;
  for (let index = Math.round(start * RATE); index < out.length; index++) {
    const t = index / RATE - start;
    phase += (2 * Math.PI * (low + (high - low) * Math.exp(-t * fall))) / RATE;
    out[index] += Math.sin(phase) * (1 - Math.exp(-t / 0.0015)) * Math.exp(-t / decay) * gain;
  }
}

// A burst of noise shaped by a low-pass (`lowpass`, 0 to 1: higher is brighter) and a high-pass
// (`highpass`, same scale), rising over `attack` seconds and dying over `decay`.
function burst(out, random, { start = 0, attack, decay, gain, lowpass, highpass = 0, flutter = 0 }) {
  let low = 0, high = 0;
  for (let index = Math.round(start * RATE); index < out.length; index++) {
    const t = index / RATE - start;
    const white = random();
    low += (white - low) * lowpass;
    high += (low - high) * highpass;
    const body = highpass ? low - high : low;
    const ripple = flutter ? 1 - flutter + flutter * Math.sin(t * 90) ** 2 : 1;
    out[index] += body * (1 - Math.exp(-t / attack)) * Math.exp(-t / decay) * gain * ripple;
  }
}

// A heavy step: a low thud with a soft scrape just after it. `weight` (0 to 1) moves the pitch.
function footstep(seed, weight) {
  const out = new Float64Array(Math.round(0.3 * RATE));
  const random = noise(seed);
  thud(out, { high: 120 - 30 * weight, low: 52 + 10 * (1 - weight), fall: 38, decay: 0.05, gain: 0.9 });
  burst(out, random, { attack: 0.0008, decay: 0.012, gain: 0.5, lowpass: 0.5 });
  burst(out, random, { start: 0.014, attack: 0.006, decay: 0.07, gain: 0.7, lowpass: 0.22, highpass: 0.02 });
  return out;
}

// Cloth moving: a swell of band-limited noise with a quick flutter in it.
function cloth() {
  const out = new Float64Array(Math.round(0.36 * RATE));
  burst(out, noise(5), { attack: 0.06, decay: 0.09, gain: 1, lowpass: 0.45, highpass: 0.08, flutter: 0.5 });
  return out;
}

const MAKERS = {
  "footstep-1": () => footstep(11, 0.8),
  "footstep-2": () => footstep(23, 0.5),
  "footstep-3": () => footstep(31, 0.2),
  cloth,
};
const WORDS = {
  footstep: "footstep footsteps step steps walk walking foot feet thud scrape",
  cloth: "cloth fabric rustle clothing sleeve jacket",
};

const cache = new Map();
// The samples of one sound, scaled so the loudest is TARGET_PEAK.
function samples(name) {
  if (!cache.has(name)) {
    const make = MAKERS[name];
    if (!make) throw new Error(`kino makes no sound called ${name}.`);
    const out = make();
    const largest = out.reduce((most, value) => Math.max(most, Math.abs(value)), 0) || 1;
    cache.set(name, out.map((value) => (value * TARGET_PEAK) / largest));
  }
  return cache.get(name);
}

/** The WAV bytes (mono, 16-bit, 44.1 kHz) of one sound made by kino. */
export function synthWav(name) {
  const data = samples(name);
  const body = Buffer.alloc(data.length * 2);
  data.forEach((value, index) => body.writeInt16LE(Math.round(value * 32767), index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + body.length, 4); header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

/** The library catalog entries of the sounds kino makes (lufs -70: under 0.4 s, read by peak). */
export function synthEntries() {
  return Object.keys(MAKERS).map((name) => {
    const data = samples(name);
    const peak = Math.round(20 * Math.log10(data.reduce((most, value) => Math.max(most, Math.abs(value)), 0)) * 10) / 10;
    return { id: name, words: WORDS[name.replace(/-\d+$/, "")], seconds: Math.round((data.length / RATE) * 100) / 100, lufs: -70, peak, synth: name };
  });
}
