// Local upload sources accepted by the media routes and renderer. Decoded frames
// depend on the GIF upload, not a separate PNG in the media library.
const UPLOAD_SOURCE = /^\/api\/media\/([a-f0-9-]+\.[a-z0-9]+)(?:\?share=[A-Za-z0-9._~-]{1,128})?$/;
const FRAME_SOURCE = /^\/api\/media\/([a-f0-9-]+\.gif)\/frames\/(0|[1-9]\d{0,5})\.png(?:\?(?:decoder=\d{1,4}(?:&share=[A-Za-z0-9._~-]{1,128})?|share=[A-Za-z0-9._~-]{1,128}))?$/;

/** An uploaded file ID and optional decoded frame index, or null for other sources. */
export function parseMediaSource(source) {
  if (typeof source !== "string") return null;
  const upload = UPLOAD_SOURCE.exec(source);
  if (upload) return { id: upload[1], frame: null };
  const frame = FRAME_SOURCE.exec(source);
  return frame ? { id: frame[1], frame: Number(frame[2]) } : null;
}
