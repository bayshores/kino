// How long scenes and animations may be.
//
// The document check (parseDocument in model.js) refuses a scene longer than MAX_TIME seconds
// and an animation whose start plus duration passes MAX_TIME. The server runs that check before
// it saves, so a refused value means every later save fails too. The Inspector and Timeline
// number fields take their min and max from here, so a typed value, a formula such as "*3" or a
// label drag stops at a value the document accepts.
import { MAX_TIME } from "./model.js";

/**
 * Seconds left between `used` and `limit`, never so many that `used + left` passes `limit`.
 * Floating-point subtraction rounds (120 - 100.1 is 19.900000000000006), and for some values
 * `used + (limit - used)` comes out a hair above `limit` (8.871719498391364 and 109.16600633302387),
 * so that hair is taken off when the sum would not fit.
 */
export function secondsLeft(used, limit = MAX_TIME) {
  let left = limit - used;
  if (left <= 0) return 0;
  if (used + left > limit) left -= Number.EPSILON * limit;
  return left;
}
