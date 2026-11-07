// Candidate order observed in the reference. Each entry represents a distinct
// H.264 profile, implementation, and audio codec, never an alias for a retry.
export const MP4_ENCODERS = [
  ["High", "high"], ["Main", "main"], ["Base", "baseline"],
].flatMap(([name, profile]) => [true, false].flatMap((hardware) =>
  ["AAC", "Opus"].map((audio) => ({
    id: `h264${name}${hardware ? "Hw" : "Sw"}${audio}`,
    profile,
    hardware,
    audio: audio.toLowerCase(),
  })),
));

export function mp4Encoder(id) {
  const encoder = MP4_ENCODERS.find((entry) => entry.id === id);
  if (!encoder) throw new Error(`Unknown MP4 encoder “${id}”.`);
  return encoder;
}

export function nextMp4Encoder(available, current) {
  const index = MP4_ENCODERS.findIndex((entry) => entry.id === (current ?? available[0]));
  return index < 0 ? null : MP4_ENCODERS.slice(index + 1).find((entry) => available.includes(entry.id))?.id ?? null;
}
