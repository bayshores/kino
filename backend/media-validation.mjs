/** Checks that upload bytes use the container declared by the upload's MIME type. */
export function mediaSignatureMatches(mime, bytes) {
  const header = Buffer.from(bytes ?? []);
  switch (mime) {
    case "image/png":
      return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    case "image/webp":
      return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"));
    case "video/mp4":
    case "audio/mp4":
      return header.subarray(4, 8).toString("ascii") === "ftyp";
    case "video/webm":
    case "audio/webm":
      return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case "audio/mpeg":
      return header.subarray(0, 3).toString("ascii") === "ID3" || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
    case "audio/wav":
    case "audio/x-wav":
      return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE";
    case "audio/ogg":
      return header.subarray(0, 4).toString("ascii") === "OggS";
    default:
      return false;
  }
}

/** Ensures ffprobe found the stream and picture dimensions promised by the MIME type. */
export function mediaStreamsMatch(mime, probe) {
  const hasPicture = probe?.hasVideo === true && Number(probe.width) > 0 && Number(probe.height) > 0;
  if (mime.startsWith("image/")) return hasPicture && probe.hasAudio !== true;
  if (mime.startsWith("video/")) return hasPicture;
  if (mime.startsWith("audio/")) return probe?.hasAudio === true && probe.hasVideo !== true;
  return false;
}
