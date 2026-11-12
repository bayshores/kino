import { numberParameter, renderVectorDisplacement } from "./periodicDisplacement.js";

// Twirl: every pixel inside the radius turns about the center by an angle that falls from
// `angle` at the center to 0 at the radius, smoothly (the square of the distance left to the
// radius). Outside the radius nothing moves, so the outer picture stays readable, unlike a spin
// blur, which smears it (GAPS item 15, contest-a p865).
//
// How: a displacement map, as bulge draws. A map moves a pixel at most 128 units with 8-bit
// steps, so a large turn is drawn as several equal smaller twirls about the same center, one
// after another (turns about one center add up exactly). Each pass moves at most PASS_REACH, so a
// step of the map is under 1.5 px; at most MAX_PASSES passes (each one resamples the picture).
const PASS_REACH = 96;
const MAX_PASSES = 6;

function turnAt(distance, radius, angle) {
  if (distance >= radius) return 0;
  const left = 1 - distance / radius;
  return angle * left * left;
}

// The farthest any pixel moves for one pass of `angle` radians: 2 r sin(turn / 2), sampled.
function farthestMove(radius, angle) {
  let farthest = 0;
  for (let step = 1; step < 128; step += 1) {
    const distance = radius * step / 128;
    farthest = Math.max(farthest, 2 * distance * Math.abs(Math.sin(turnAt(distance, radius, angle) / 2)));
  }
  return farthest;
}

export function renderTwirl(frame) {
  const angle = numberParameter(frame, "angle", 180, -720, 720) * Math.PI / 180;
  if (angle === 0) return frame.content;
  const { width, height } = frame.bounds;
  const radius = numberParameter(frame, "radius", 0.5, 0.05, 2) * Math.min(width, height);
  const centerX = numberParameter(frame, "centerX", 0.5, 0, 1) * width;
  const centerY = numberParameter(frame, "centerY", 0.5, 0, 1) * height;
  const whole = farthestMove(radius, angle);
  if (whole < 0.25) return frame.content;
  const passes = Math.min(MAX_PASSES, Math.max(1, Math.ceil(whole / PASS_REACH)));
  const turn = angle / passes;
  const reach = Math.min(128, farthestMove(radius, turn));
  if (reach < 0.25) return frame.content;
  const key = JSON.stringify(["twirl-v1", turn, radius, centerX, centerY, width, height]);
  const field = (u, v) => {
    const x = u * width - centerX, y = v * height - centerY;
    const theta = turnAt(Math.hypot(x, y), radius, turn);
    if (theta === 0) return { x: 0, y: 0 };
    // Each output pixel reads the source turned back by theta, so the picture turns by +theta
    // (clockwise on screen for a positive angle).
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const sourceX = cos * x + sin * y, sourceY = -sin * x + cos * y;
    const clamp = (value) => Math.max(-1, Math.min(1, value / reach));
    return { x: clamp(sourceX - x), y: clamp(sourceY - y) };
  };
  let content = frame.content;
  for (let pass = 0; pass < passes; pass += 1)
    content = renderVectorDisplacement({ ...frame, content }, key, reach, field, { padding: reach + 1 });
  return content;
}
