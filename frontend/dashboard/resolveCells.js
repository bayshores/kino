// The text shades a loading picture shows (resolve.jsx): `rows` rows of `cols` characters from
// " .:-=+*#%@", a soft pattern that is the same every time for the same picture, and for each
// cell the delay (ms) before it clears: 40 ms a row from the top plus up to 140 ms of jitter.
const SHADES = " .:-=+*#%@";

/** A small number from a string (FNV-1a), so the same picture gets the same pattern. */
function hash(text) {
  let value = 2166136261;
  for (const char of String(text)) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

export function asciiCells(seedText, rows = 9, cols = 14) {
  let seed = hash(seedText) || 1;
  const next = () => { seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0; seed ^= seed >>> 13; return (seed >>> 0) / 4294967296; };
  const phase = next() * 6;
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    const wave = (Math.sin(c * 0.45 + phase) + Math.sin(r * 0.7 - c * 0.2 + phase * 2) + 2) / 4;
    const level = Math.min(SHADES.length - 1, Math.max(0, Math.floor((wave * 0.85 + next() * 0.15) * SHADES.length)));
    return { char: SHADES[level], delay: Math.round(r * 40 + next() * 140) };
  }));
}
