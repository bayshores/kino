// The weak-agent script: what a Haiku-class agent gets from kino with the fewest calls. No model
// runs: each case is a fixed call list (status, project create, one edit, check {fix:"auto"},
// render draft), the way the skill's short path says, for 10 briefs from evals/briefs.json and 3
// sloppy hand-built scenes (linear easing, tiny text, overlapping text). Each must end with 0
// errors and at most 3 warnings, in at most 5 calls: one check {fix:"auto"} does the fixing loop.
//
// Run it by hand (it renders 13 drafts, about a minute each; not part of npm test):
//   node --import ./scripts/test-fonts.mjs tests/weak-agent-script.mjs [case ids, comma separated]
// RENDER=0 skips the draft renders; SHOW=1 prints what is left after the fix.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startTestServer } from "../backend/media.test.support.mjs";

const MAX_CALLS = 5;
const MAX_WARNINGS = 3;
const briefs = JSON.parse(await readFile(new URL("../evals/briefs.json", import.meta.url), "utf8"));
const briefById = Object.fromEntries(briefs.briefs.map((brief) => [brief.id, brief]));

// The brand kit as one set_brand op (in the same edit as compose: no extra call).
function brandOp(name) {
  const brand = briefs.brands[name];
  return { op: "set_brand", name, colors: brand.colors, fonts: [{ family: brand.fonts.display }, { family: brand.fonts.body }], logos: [{ text: brand.name }] };
}
const FORMAT = { "1920x1080": "16:9", "1080x1920": "9:16", "1080x1080": "1:1" };

// Three beats per brief, written from its text the way a weak agent would.
const BEATS = {
  "promo-01": [{ recipe: "logo-sting", tagline: "Plan the week in one view" }, { recipe: "feature-callout", text: "Shared calendars", sub: "Everyone sees the same week" }, { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app" }],
  "promo-02": [{ recipe: "logo-sting", tagline: "Travel slower. See more." }, { recipe: "feature-callout", text: "Stays of a week or more", sub: "Hand-picked homes" }, { recipe: "cta-end", text: "Book your stay", sub: "fernway.travel" }],
  "promo-03": [{ recipe: "logo-sting", tagline: "Your commute, rewired" }, { recipe: "feature-callout", text: "80 km of range", sub: "On one charge" }, { recipe: "cta-end", text: "Ride it this weekend", sub: "voltline.bike" }],
  "promo-04": [{ recipe: "logo-sting", tagline: "Your savings, actually growing" }, { recipe: "feature-callout", text: "No fees, ever", sub: "Open in five minutes" }, { recipe: "cta-end", text: "Open an account", sub: "kelp.bank" }],
  "promo-05": [{ recipe: "logo-sting", tagline: "Autumn is in the oven" }, { recipe: "feature-callout", text: "Pumpkin loaf", sub: "Baked fresh every morning" }, { recipe: "cta-end", text: "Order today", sub: "mapleandco.com" }],
  "clip-01": [{ recipe: "hook-slam", text: "Stop double-booking." }, { recipe: "tip-card", title: "Tip 1", text: "Share one calendar with your whole team" }, { recipe: "follow-cta", text: "Follow for more", handle: "@orbit" }],
  "clip-02": [{ recipe: "hook-slam", text: "3 reasons to bike to work" }, { recipe: "caption-pop", text: "Faster than traffic, free exercise, no parking" }, { recipe: "follow-cta", text: "Follow for more", handle: "@voltline" }],
  "clip-06": [{ recipe: "hook-slam", text: "New: swell forecasts" }, { recipe: "caption-pop", text: "Know the waves before you paddle out" }, { recipe: "follow-cta", text: "Try it today", handle: "@tidallabs" }],
  "explainer-02": [{ recipe: "headline-reveal", text: "How compound interest grows", kicker: "Explainer" }, { recipe: "bar-chart-grow", title: "$1,000 at 5%", bars: [{ label: "Y1", value: 1050 }, { label: "Y3", value: 1158 }, { label: "Y5", value: 1276 }] }, { recipe: "number-counter", value: 276, prefix: "$", label: "earned in five years" }],
  "explainer-04": [{ recipe: "headline-reveal", text: "How to book a slow-travel stay", kicker: "Guide" }, { recipe: "step-list", title: "Three steps", items: ["Pick a region", "Choose 7 nights or more", "Book and pack light"] }, { recipe: "cta-end", text: "Book at fernway.travel", sub: "Stays of a week or more" }],
};

// A brief's call list: status, create, one edit (brand + compose), check {fix:"auto"}, render.
function briefCalls(id) {
  const brief = briefById[id];
  const [width, height] = brief.format.split("x").map(Number);
  const type = brief.type === "vertical-clip" ? "clip" : brief.type;
  return [
    ["status", {}],
    ["project", { action: "create", id, name: id, width, height, duration: brief.duration }],
    ["edit", { project: id, ops: [brandOp(brief.brand), { op: "compose", type, format: FORMAT[brief.format], duration: brief.duration, beats: BEATS[id] }] }],
  ];
}

// Sloppy scenes a weak agent writes by hand: one edit of add_layer ops.
const text = (name, value, properties, animations) => ({ op: "add_layer", layerType: "text", name,
  properties: { fontFamily: "Inter", fontSize: 96, fill: "#f4f6fb", textResize: "width-height", ...properties, text: value }, animations });
const SLOPPY = {
  "sloppy-linear": [
    text("title", "Plan the week in one view", { x: 260, y: 420 }, [{ preset: "preset-slide", start: 0, duration: 0.6, easing: "linear" }, { preset: "preset-fade", mode: "out", start: 3.4, duration: 0.6, easing: "linear" }]),
    text("sub", "Shared calendars for teams", { fontSize: 48, x: 260, y: 560 }, [{ preset: "preset-fade", start: 0.4, duration: 0.6, easing: "linear" }]),
  ],
  "sloppy-tiny": [
    text("title", "Orbit", { fontSize: 120, x: 760, y: 360 }, [{ preset: "preset-fade", start: 0.2, duration: 0.5 }]),
    text("fine", "Free for teams of up to ten people", { fontSize: 14, x: 760, y: 560 }, [{ preset: "preset-fade", start: 0.5, duration: 0.5 }]),
  ],
  "sloppy-overlap": [
    text("title", "Plan the week", { x: 300, y: 400 }, [{ preset: "preset-fade", start: 0.2, duration: 0.5 }]),
    text("tag", "in one view", { x: 420, y: 430 }, [{ preset: "preset-fade", start: 0.4, duration: 0.5 }]),
  ],
};
function sloppyCalls(id) {
  return [
    ["status", {}],
    ["project", { action: "create", id, name: id, width: 1920, height: 1080, duration: 4, background: "#0f1420" }],
    ["edit", { project: id, ops: SLOPPY[id] }],
  ];
}

const CASES = [...Object.keys(BEATS).map((id) => [id, briefCalls(id)]), ...Object.keys(SLOPPY).map((id) => [id, sloppyCalls(id)])];

const only = process.argv[2]?.split(",");
const render = process.env.RENDER !== "0";
const server = await startTestServer();
const failures = [];
try {
  for (const [id, start] of CASES) {
    if (only && !only.includes(id)) continue;
    const calls = [...start, ["check", { project: id, fix: "auto" }], ...(render ? [["render", { project: id, action: "start", quality: "draft", wait: true }]] : [])];
    const answers = [];
    for (const [verb, body] of calls) {
      const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
      const answer = await response.json();
      answers.push(answer);
      if (response.status !== 200 || answer.isError) { failures.push(`${id}: ${verb} failed: ${String(answer.text ?? answer.error ?? "").slice(0, 400)}`); break; }
    }
    if (answers.length !== calls.length) continue;
    const checked = answers[start.length].data;
    const line = `${id}: ${calls.length} calls, ${checked.errors} errors, ${checked.warnings} warnings after the fix`;
    console.log(line);
    if (process.env.SHOW) console.log(answers[start.length].text);
    try {
      assert.ok(calls.length <= MAX_CALLS, `${calls.length} calls`);
      assert.equal(checked.errors, 0, "errors");
      assert.ok(checked.warnings <= MAX_WARNINGS, `${checked.warnings} warnings`);
      if (render) assert.match(JSON.stringify(answers.at(-1).data ?? {}), /\.mp4/, "render made a file");
    } catch (error) {
      failures.push(`${line} (${error.message})\n${answers[start.length].text}`);
    }
  }
} finally {
  await server.stop();
}
if (failures.length) {
  console.log(`\n${failures.length} failed:\n${failures.join("\n\n")}`);
  process.exitCode = 1;
} else console.log("all cases clean");
