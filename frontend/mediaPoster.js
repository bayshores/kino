/** A static source frame, scoped by the same media authorization as playback. */
export function mediaPosterPath(src, sourceTime = 0) {
  if (typeof src !== "string" || !/^\/api\/media\/[a-z0-9_-]{1,128}\.[a-z0-9]{1,8}$/i.test(src) || !Number.isFinite(sourceTime)) return null;
  const milliseconds = Math.round(Math.max(0, Math.min(86_400, sourceTime)) * 1000);
  return `${src}/poster/${milliseconds}.png`;
}
