// <Bot color mood size gaze still />: an agent drawn as a small circle in its color with two dark
// eyes that show its mood (bot.js has the moods, shapes and curves). It blinks, looks toward the
// pointer (or toward `gaze`), squashes and springs back on every mood change, breathes while it
// works, hops while it waits for you, shakes on an error and dozes ("z") when asleep.
//
// Light to draw: every bot on the page shares ONE loop (the `bots` set below), and that loop only
// runs frame by frame (requestAnimationFrame) while some bot really moves: a mood change's
// squash, a hop or shake, eyes easing toward the pointer, or a working bot scanning and
// breathing. A bot at rest (idle, done, held, asleep) needs no frames: its blinks, glances and
// its sleeping "z" are steps that one timer (for all bots) wakes the loop for. While the stage
// plays (useQuietBots) the bots are quiet: no blinks, glances, breathing, "z" or pointer
// following, so they add nothing to the frames playback draws. Each step only sets SVG
// attributes, and only those whose text changed; the only layout read is each bot's place on
// screen, for looking at the pointer, at most every 250 ms and only after the pointer moved.
// Under reduced motion (`still`, or the system setting) the body stays put: no hops, shakes,
// leaning or breathing; the eyes still change shape and blink every 10 s.
//
// A bot is decoration: aria-hidden, never focusable. The agent's name next to it is the text.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./bot.css";
import {
  EYE_COLOR, EYE_X, GLYPHS, NO_BLINK, Z_STEP_MS, blinkEdges, blinkShut, easeToward, eyeShape, glyphStroke, hop, nextBlinkIn, shake, wobble, zStep,
} from "./bot.js";
import { DEFAULT_COLOR } from "./presence.js";

// ---- the shared loop -----------------------------------------------------------------------

const bots = new Set();
const pointer = { x: 0, y: 0, movedAt: -Infinity, seen: false };
let frameId = 0;
let timerId = 0;
let lastFrame = 0;
let reduceQuery = null;
// How many parts of the page ask the bots to be quiet (the stage while it plays).
let quietAsks = 0;

/** How many animation frames and timer steps the loop has asked for (window.kinoBotLoop, for checks). */
export const botLoopCounts = { frames: 0, timers: 0 };
if (typeof window !== "undefined") window.kinoBotLoop = botLoopCounts;

const systemStill = () => {
  if (!reduceQuery && typeof window !== "undefined" && window.matchMedia) reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  return Boolean(reduceQuery?.matches);
};

function onPointerMove(event) {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.movedAt = performance.now();
  pointer.seen = true;
  // The eyes follow the pointer, except while the stage plays.
  if (!quietAsks) wake();
}

function onVisibility() {
  if (document.hidden) stopLoop();
  else wake();
}

/** Draws the bots on the next display frame (a waiting timer step is dropped: this comes first). */
function wake() {
  if (frameId || !bots.size || typeof document === "undefined" || document.hidden) return;
  if (timerId) clearTimeout(timerId);
  timerId = 0;
  botLoopCounts.frames += 1;
  frameId = requestAnimationFrame(frame);
}

function stopLoop() {
  if (frameId) cancelAnimationFrame(frameId);
  if (timerId) clearTimeout(timerId);
  frameId = 0;
  timerId = 0;
}

function register(bot) {
  if (!bots.size) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
  }
  bots.add(bot);
  wake();
}

function unregister(bot) {
  bots.delete(bot);
  if (bots.size) return;
  stopLoop();
  window.removeEventListener("pointermove", onPointerMove);
  document.removeEventListener("visibilitychange", onVisibility);
}

/**
 * Asks every bot on the page to be quiet while `on` (the stage passes `playing`): no blinks,
 * glances, breathing, "z" or pointer following, so the bots ask for no frames during playback.
 */
export function useQuietBots(on) {
  useEffect(() => {
    if (!on) return undefined;
    quietAsks += 1;
    // One more step settles every bot (its body goes still).
    wake();
    return () => {
      quietAsks -= 1;
      wake();
    };
  }, [on]);
}

// One step of every bot, then the next: the next display frame while a bot moves, else a timer
// for the soonest blink, glance, hop or "z" step, else nothing until a bot or the pointer changes.
function frame(now) {
  frameId = 0;
  // A long pause (a hidden tab, a busy page, a bot at rest) does not make the bots jump.
  const dt = Math.min(64, Math.max(0, now - lastFrame));
  lastFrame = now;
  const quiet = quietAsks > 0;
  const still = systemStill();
  // All the reads first, then all the writes, so the browser lays the page out once at most.
  if (!quiet) for (const bot of bots) readPlace(bot, now);
  let next = Infinity;
  for (const bot of bots) next = Math.min(next, step(bot, now, dt, still || bot.still || quiet, quiet));
  if (!bots.size || document.hidden) return;
  if (next <= now) {
    botLoopCounts.frames += 1;
    frameId = requestAnimationFrame(frame);
  } else if (Number.isFinite(next)) {
    botLoopCounts.timers += 1;
    timerId = setTimeout(() => { timerId = 0; frame(performance.now()); }, next - now);
  }
}

// Where the bot is on screen, for looking at the pointer: only when the pointer moved since.
function readPlace(bot, now) {
  if (bot.gazeTarget || !pointer.seen || !bot.svg) return;
  if (bot.placeAt > pointer.movedAt || now - bot.placeAt < 250) return;
  const box = bot.svg.getBoundingClientRect();
  bot.place = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  bot.placeAt = now;
}

const clamp = (value) => Math.max(-1, Math.min(1, value));
// Close enough to its target that easing on would change nothing on screen.
const near = (a, b) => Math.abs(a - b) < 0.01;

// Sets an attribute only when its text changes: most steps a bot looks the same as the step
// before, and then the loop writes nothing, so the page has nothing new to draw. (The awake
// bots' unseen "z" moved on every frame, so an idle dashboard was drawn again on every display
// frame: with CPU drawing that was 1.6 cores of a Mac.)
function setAttr(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/**
 * One step of one bot: works out its eyes and body from its mood and the time, and draws them.
 * Returns when it needs its next step: `now` (the next display frame) while it moves, a later
 * time for its next blink, glance, hop or "z" step, or Infinity. `quiet`: the stage plays.
 */
function step(bot, now, dt, still, quiet) {
  const mood = bot.mood;
  if (!bot.svg) return Infinity;
  // Eyes ease while the pointer moves or the mood just changed; a glance, a blink or a new gaze
  // target at rest is a jump, so a resting bot needs no frames.
  const pointerMoving = !quiet && now - pointer.movedAt < 400;
  const squashing = !still && now - bot.squashAt < 600;
  const snap = still || (!pointerMoving && !squashing);

  // Blink: shut for 120 ms on a random 3–6 s clock (10 s under reduced motion); none while quiet.
  if (!quiet && now > bot.nextBlink) {
    if (!NO_BLINK.has(mood)) {
      bot.blinkAt = now;
      bot.double = !still && Math.random() < 0.2;
    }
    bot.nextBlink = now + nextBlinkIn(still, Math.random());
  }
  const shut = quiet ? 0 : blinkShut(now - bot.blinkAt, bot.double);

  // Gaze, -1 to 1 each way: toward `gaze` when given, else the pointer; a working bot scans
  // side to side; an idle bot glances around when the pointer has rested for 3 s.
  let gx = 0;
  let gy = 0;
  if (bot.gazeTarget) {
    gx = clamp(bot.gazeTarget.x);
    gy = clamp(bot.gazeTarget.y);
  } else if (!quiet && bot.place && pointer.seen) {
    gx = clamp((pointer.x - bot.place.x) / 260);
    gy = clamp((pointer.y - bot.place.y) / 260);
  }
  if (mood === "idle" && !bot.gazeTarget && !quiet) {
    if (now > bot.nextWander) {
      if (now - pointer.movedAt > 3000) bot.wander = { x: Math.random() * 2 - 1, y: Math.random() * 1.2 - 0.6, until: now + 500 + Math.random() * 400 };
      bot.nextWander = now + 5000 + Math.random() * 5000;
    }
    if (bot.wander && now < bot.wander.until) { gx = bot.wander.x; gy = bot.wander.y; }
  }
  const scanning = mood === "work" && !still;
  if (mood === "work") { gx = scanning ? Math.sin((now / 900) * Math.PI * 2 + bot.phase) * 0.6 : 0; gy = 0; }
  if (mood === "look") { gx *= 1.3; gy *= 1.2; }
  if (mood === "held" || mood === "sleep" || mood === "done" || mood === "error") { gx = 0; gy = 0; }
  const gazeMs = snap && !scanning ? 1 : 90;
  bot.gaze.x = easeToward(bot.gaze.x, gx * 2.2, dt, gazeMs);
  bot.gaze.y = easeToward(bot.gaze.y, gy * 1.2, dt, gazeMs);

  // The eyes ease to the mood's shape; hovering a bot widens its eyes a little.
  const target = eyeShape(mood, bot.size);
  const wide = bot.hover && (mood === "idle" || mood === "look" || mood === "wait") ? 1.15 : 1;
  const shapeMs = still ? 40 : 70;
  const eyeY = target.y - (wide - 1) * 3;
  const eyeW = target.w * (wide > 1 ? 1.08 : 1);
  const eyeH = target.h * wide;
  bot.eye.y = easeToward(bot.eye.y, eyeY, dt, shapeMs);
  bot.eye.w = easeToward(bot.eye.w, eyeW, dt, shapeMs);
  bot.eye.h = easeToward(bot.eye.h, eyeH, dt, shapeMs);
  // ^ ^ and × × fade in once the eye rects have closed.
  const glyphTarget = {};
  for (const glyph of ["done", "error"]) {
    glyphTarget[glyph] = mood === glyph && bot.eye.h < 1 ? 1 : 0;
    bot.glyph[glyph] = easeToward(bot.glyph[glyph], glyphTarget[glyph], dt, still ? 60 : 50);
  }
  // Held: the whole bot dims to 45%.
  const opacityTarget = mood === "held" ? 0.45 : 1;
  bot.opacity = easeToward(bot.opacity, opacityTarget, dt, still ? 40 : 120);
  // Settled: everything is where it is going, so it lands exactly there and stops easing.
  const settled = near(bot.gaze.x, gx * 2.2) && near(bot.gaze.y, gy * 1.2) && near(bot.eye.y, eyeY) && near(bot.eye.w, eyeW)
    && near(bot.eye.h, eyeH) && near(bot.glyph.done, glyphTarget.done) && near(bot.glyph.error, glyphTarget.error) && near(bot.opacity, opacityTarget);
  if (settled && !scanning) {
    bot.gaze.x = gx * 2.2; bot.gaze.y = gy * 1.2;
    bot.eye.y = eyeY; bot.eye.w = eyeW; bot.eye.h = eyeH;
    bot.glyph.done = glyphTarget.done; bot.glyph.error = glyphTarget.error; bot.opacity = opacityTarget;
  }

  const h = Math.max(0.01, bot.eye.h * (1 - shut * 0.9));
  const y = bot.eye.y + (bot.eye.h - h) / 2 + bot.gaze.y;
  bot.eyes.forEach((eye, index) => {
    const x = EYE_X[index] + bot.gaze.x - bot.eye.w / 2;
    setAttr(eye, "x", x.toFixed(2));
    setAttr(eye, "y", y.toFixed(2));
    setAttr(eye, "width", bot.eye.w.toFixed(2));
    setAttr(eye, "height", h.toFixed(2));
    setAttr(eye, "rx", (Math.min(bot.eye.w, h) / 2).toFixed(2));
  });
  for (const glyph of ["done", "error"]) setAttr(bot.glyphs[glyph], "opacity", bot.glyph[glyph].toFixed(2));

  // The body: squash on a mood change, breathing while it works, a hop every 4 s while it waits
  // for you and once when it is done, a shake on an error, a lean toward where it looks.
  let sx = 1;
  let sy = 1;
  let lift = 0;
  let shift = 0;
  let lean = 0;
  if (!still) {
    const w = wobble(now - bot.squashAt);
    sx += 0.12 * w;
    sy -= 0.14 * w;
    if (mood === "work") { const breath = Math.sin((now / 2400) * Math.PI * 2 + bot.phase) * 0.015; sx += breath; sy += breath; }
    if (mood === "wait" && now > bot.nextHop) { bot.hopAt = now; bot.nextHop = now + 4000; }
    lift = hop(now - bot.hopAt) * (mood === "done" ? 3 : 4);
    if (now - bot.hopAt >= 0 && now - bot.hopAt < 70) { sx += 0.08; sy -= 0.1; }
    shift = shake(now - bot.shakeAt) * 2;
    lean = bot.gaze.x * 1.2;
  }
  setAttr(bot.body, "transform", `translate(${(12 + shift).toFixed(2)} ${(24 - lift).toFixed(2)}) rotate(${lean.toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(-12 -24)`);

  const opacity = bot.opacity.toFixed(2);
  if (bot.shownOpacity !== opacity) { bot.svg.style.opacity = opacity; bot.shownOpacity = opacity; }
  // Asleep: a "z" rises in steps and goes, every 2.6 s (it stays put under reduced motion and
  // while the stage plays).
  const z = mood !== "sleep" ? { y: 1, opacity: 0 } : still ? { y: 1, opacity: 0.9 } : zStep(Math.floor(now / Z_STEP_MS));
  setAttr(bot.z, "opacity", z.opacity.toFixed(2));
  // The "z" is at least 4 px tall at 12–16 px and 7 px from 24 px up (the 28 px stage bots).
  const zScale = Math.max(1, ((bot.size >= 24 ? 7 : 4) * 24) / Math.max(1, bot.size) / 3.6);
  setAttr(bot.z, "transform", `translate(19 ${z.y.toFixed(2)}) scale(${zScale.toFixed(2)})`);

  // When this bot needs its next step.
  const hopMs = now - bot.hopAt;
  const shakeMs = now - bot.shakeAt;
  const moving = !settled || scanning || squashing || (!still && ((hopMs >= 0 && hopMs < 260) || (shakeMs >= 0 && shakeMs < 360)));
  if (moving) return now;
  if (quiet) return Infinity;
  let next = Infinity;
  const soonest = (time) => { if (time > now && time < next) next = time; };
  if (!NO_BLINK.has(mood)) soonest(bot.nextBlink);
  for (const edge of blinkEdges(bot.double)) soonest(bot.blinkAt + edge);
  if (mood === "idle" && !bot.gazeTarget) { soonest(bot.nextWander); if (bot.wander) soonest(bot.wander.until); }
  if (!still) { soonest(bot.hopAt); soonest(bot.shakeAt); if (mood === "wait") soonest(bot.nextHop); }
  if (mood === "sleep" && !still) soonest((Math.floor(now / Z_STEP_MS) + 1) * Z_STEP_MS);
  return next;
}

/** A bot's mood changed: squash, and start what the new mood does once. */
function changeMood(bot, mood, now = performance.now()) {
  if (bot.mood === mood) return;
  bot.mood = mood;
  bot.squashAt = now;
  if (mood === "done") bot.hopAt = now + 120;
  if (mood === "error") bot.shakeAt = now + 60;
  if (mood === "wait") bot.nextHop = now + 300;
  wake();
}

// ---- the component -------------------------------------------------------------------------

/**
 * `color` the agent's color, `mood` one of bot.js MOODS, `size` in px (12–16 in the panes),
 * `gaze` an optional { x, y } direction (-1 to 1 each way) to look in instead of the pointer,
 * `still` the dashboard's reduced motion.
 */
export function Bot({ color, mood = "idle", size = 14, gaze = null, still = false, className = "" }) {
  const svgRef = useRef(null);
  // The first shape is drawn by React; after that only the loop changes the eyes and body.
  const [first] = useState(() => ({ mood, eye: eyeShape(mood, size) }));
  const bot = useRef(null);
  if (!bot.current) {
    const now = typeof performance === "undefined" ? 0 : performance.now();
    bot.current = {
      svg: null, body: null, eyes: [], glyphs: {}, z: null,
      mood, size, still, gazeTarget: gaze, hover: false, opacity: 1,
      eye: { ...first.eye }, gaze: { x: 0, y: 0 }, glyph: { done: mood === "done" ? 1 : 0, error: mood === "error" ? 1 : 0 },
      squashAt: -Infinity, hopAt: -Infinity, shakeAt: -Infinity, nextHop: 0, blinkAt: -Infinity, double: false,
      // Each bot blinks and breathes on its own clock, so a crew does not move in step.
      nextBlink: now + 800 + Math.random() * 3200, nextWander: now + 6000 + Math.random() * 6000, wander: null,
      phase: Math.random() * Math.PI * 2, place: null, placeAt: -Infinity,
    };
  }
  const state = bot.current;
  state.size = size;
  state.still = still;
  state.gazeTarget = gaze;

  useLayoutEffect(() => {
    const svg = svgRef.current;
    state.svg = svg;
    state.body = svg.querySelector("[data-part=body]");
    state.eyes = [...svg.querySelectorAll("[data-part=eye]")];
    state.glyphs = { done: svg.querySelector("[data-part=done]"), error: svg.querySelector("[data-part=error]") };
    state.z = svg.querySelector("[data-part=z]");
    register(state);
    return () => unregister(state);
  }, [state]);

  useEffect(() => { changeMood(state, mood); }, [state, mood]);
  // A new size, reduced motion or place to look at takes one more step (none while the stage
  // plays: then a bot that rides with a moving layer keeps its eyes until playback stops).
  const gazeKey = gaze ? `${gaze.x.toFixed(2)},${gaze.y.toFixed(2)}` : "";
  useEffect(() => { if (!quietAsks) wake(); }, [state, size, still, gazeKey]);

  const stroke = glyphStroke(size);
  return (
    <svg ref={svgRef} className={`bot${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24"
      aria-hidden="true" focusable="false" data-mood={mood}
      onPointerEnter={() => { state.hover = true; wake(); }} onPointerLeave={() => { state.hover = false; wake(); }}>
      <g data-part="body">
        {/* An older agent row has no color: it gets the first agent color (teal). */}
        <circle cx="12" cy="12" r="12" fill={color || DEFAULT_COLOR} />
        {EYE_X.map((x) => (
          <rect key={x} data-part="eye" fill={EYE_COLOR} x={x - first.eye.w / 2} y={first.eye.y} width={first.eye.w} height={first.eye.h} rx={Math.min(first.eye.w, first.eye.h) / 2} />
        ))}
        <path data-part="done" d={GLYPHS.done.join(" ")} stroke={EYE_COLOR} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={first.mood === "done" ? 1 : 0} />
        <path data-part="error" d={GLYPHS.error.join(" ")} stroke={EYE_COLOR} strokeWidth={stroke} strokeLinecap="round" fill="none" opacity={first.mood === "error" ? 1 : 0} />
      </g>
      {/* A "z" drawn as a line (not text, so it never shows up in the line's words). */}
      <path data-part="z" d="M0 0 H3.6 L0 3.6 H3.6" stroke="#808792" strokeWidth={Math.max(1, stroke * 0.6)} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0" />
    </svg>
  );
}
