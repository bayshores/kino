// Shared pieces of the moves gate (creative seeds M3): a project with the layers each move's
// library example names (two full-frame shots, a phone, three card pictures and a brand logo),
// and a check that the example, run as written through the agent API, passes every gate.
// backend/agent-moves.test.mjs runs a sample (each move once, in 16:9, 9:16 or reduced motion in
// turn); the full sweep (every move in all three) is run by hand:
//
//   node --import ./scripts/test-fonts.mjs tests/moves-gate.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { MOVE_NAMES } from "../engine/blocks/moves/index.js";
import { compactRecording } from "../engine/recording.js";

// Made-up pictures that are hard on the gates: a bright street with a pale sky (light captions
// need their shade), a wall with a dark page on it, and a phone screen.
const STREET = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9CC3E0"/><stop offset="1" stop-color="#EEF2F4"/></linearGradient></defs>
<rect width="1920" height="1080" fill="url(#sky)"/><rect x="80" y="260" width="420" height="560" fill="#3A4048"/><rect x="560" y="380" width="300" height="440" fill="#59606B"/>
<rect x="1180" y="200" width="520" height="620" fill="#4A515B"/><rect x="0" y="820" width="1920" height="260" fill="#C9CCD0"/><rect x="0" y="930" width="1920" height="30" fill="#F2F2EE"/></svg>`;
const WALL = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="1920" height="1080" fill="#D9C9B0"/><rect x="640" y="160" width="640" height="760" rx="18" fill="#20242B"/>
<rect x="700" y="230" width="520" height="90" rx="10" fill="#FF4D94"/><rect x="700" y="380" width="520" height="40" rx="8" fill="#E8E4DC"/>
<rect x="700" y="450" width="380" height="40" rx="8" fill="#E8E4DC"/><circle cx="960" cy="700" r="120" fill="#3CC8B4"/></svg>`;
const screen = (accent) => `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1564" viewBox="0 0 720 1564">
<rect width="720" height="1564" rx="64" fill="#121317"/><rect x="48" y="140" width="624" height="120" rx="24" fill="${accent}"/>
<rect x="48" y="300" width="624" height="520" rx="28" fill="#2A2D35"/><rect x="48" y="860" width="420" height="44" rx="12" fill="#EDEBE6"/>
<rect x="48" y="930" width="560" height="44" rx="12" fill="#8C8F98"/><circle cx="360" cy="1300" r="90" fill="${accent}"/></svg>`;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<circle cx="256" cy="256" r="220" fill="#FF4D94"/><path d="M170 330 L256 150 L342 330 Z" fill="#0B0B0D"/></svg>`;
const BRAND = { name: "acme", colors: { bg: "#0B0B0D", surface: "#17171A", text: "#F5F3F0", accent: "#FF4D94", accent2: "#FFC2DA" } };

// Each picture is drawn once and kept: a 1920 × 1080 draw takes about 0.15 s, and every move's
// project uploads seven of them.
const drawn = new Map();
const png = (svg) => {
  if (!drawn.has(svg)) drawn.set(svg, Buffer.from(new Resvg(svg).render().asPng()));
  return drawn.get(svg);
};

/** The API helpers for one test server: agent verbs and picture uploads. */
export function movesApi(server) {
  async function agent(project, verb, body = {}) {
    const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project, ...body } });
    assert.equal(response.status, 200, `${verb} answers 200`);
    return response.json();
  }
  async function upload(project, name, svg) {
    const response = await server.api(`/api/media?project=${project}`, { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": name }, body: png(svg) });
    assert.equal(response.status, 201);
    return response.json();
  }
  return { agent, upload };
}

// A 6 s moving test picture (FFmpeg's testsrc2) the size of the frame, for the footage moves' "clip".
async function uploadClip(server, project, width, height) {
  const { ffmpeg, run } = await import("../backend/media.test.support.mjs");
  const folder = await mkdtemp(path.join(tmpdir(), "kino-moves-"));
  try {
    const file = path.join(folder, "clip.mp4");
    await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=6`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
    const response = await server.api(`/api/media?project=${project}`, { method: "POST", headers: { "Content-Type": "video/mp4", "X-File-Name": "clip.mp4" }, body: await readFile(file) });
    assert.equal(response.status, 201);
    return response.json();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * Makes project `id` at width × height with the layers the examples name: shot-b (a wall with
 * a page), shot-a (a street, on top), phone (a phone screen in the middle), the pictures
 * screen-a, screen-b and screen-c, and the brand "acme" with a logo.
 */
export async function setUpProject(api, id, { width, height, duration = 5 }) {
  const made = await api.agent(id, "project", { action: "create", id, name: id, width, height, duration, background: BRAND.colors.bg });
  assert.equal(made.isError, undefined, made.text);
  const street = await api.upload(id, "street.png", STREET);
  const wall = await api.upload(id, "wall.png", WALL);
  const logo = await api.upload(id, "logo.png", LOGO);
  const phone = await api.upload(id, "phone.png", screen("#3CC8B4"));
  for (const [name, accent] of [["screen-a", "#FF4D94"], ["screen-b", "#3CC8B4"], ["screen-c", "#FFB020"]]) await api.upload(id, `${name}.png`, screen(accent));
  // A picture that covers the whole frame (cropped at the sides or top), like a shot.
  const cover = (src) => {
    const scale = Math.max(width / 1920, height / 1080);
    const w = Math.round(1920 * scale), h = Math.round(1080 * scale);
    return { src, x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
  };
  const phoneHeight = Math.round(height * (height > width ? 0.62 : 0.8));
  const phoneWidth = Math.round(phoneHeight * 720 / 1564);
  const setup = await api.agent(id, "edit", { ops: [
    { op: "set_brand", ...BRAND, logos: [{ media: logo.id }] },
    { op: "add_layer", layerType: "image", name: "shot-b", properties: cover(wall.src) },
    { op: "add_layer", layerType: "image", name: "shot-a", properties: cover(street.src) },
    { op: "add_layer", layerType: "image", name: "phone", properties: { src: phone.src, x: Math.round((width - phoneWidth) / 2), y: Math.round((height - phoneHeight) / 2), width: phoneWidth, height: phoneHeight, radius: Math.round(phoneWidth * 0.09) } },
  ] });
  assert.equal(setup.isError, undefined, setup.text);
}

/** The example op from library {topic:"moves", name}, exactly as an agent reads it. */
export async function libraryExample(api, project, name) {
  const reply = await api.agent(project, "library", { topic: "moves", name });
  assert.equal(reply.isError, undefined, reply.text);
  const line = reply.text.split("\n").find((entry) => entry.startsWith("example: "));
  assert.ok(line, `${name} has an example`);
  return JSON.parse(line.slice("example: ".length));
}

// The layers the examples use; each move gets a project with only the ones it needs, so the
// other layers do not cover what it makes; the rest are deleted first.
const USES = {
  "caption-words": ["shot-a"],
  "push-through-type": ["shot-a"],
  "status-line": ["shot-a"],
  "logo-match-move": ["shot-b"],
  "speed-lines-phone": ["phone"],
  "swipe-cards": [],
  "rgb-split-hit": ["shot-a"],
  "parallax-stack": ["shot-a", "phone"],
  "tile-ring": ["shot-a"],
  "window-punch-in": ["shot-b"],
  "ui-plane": ["shot-b"],
  "lift-focus": ["shot-b"],
  "card-into-device": ["phone"],
  "headline-write": [],
  "logo-settle": [],
  "count-up": [],
  "draw-on": [],
  "freeze-shutter": ["clip"],
  "masked-type": ["clip"],
  roll: [],
  "type-on": [],
  stream: [],
  rewrite: [],
  decode: [],
  assemble: [],
  "build-in": ["shot-a", "phone"],
  carry: ["phone"],
  "accent-hit": [],
  "light-sweep": [],
  cursor: ["shot-b"],
  "screen-recording": ["clip"],
};
// screen-recording's clip carries a recording (as project record stop leaves one): a pointer
// slide, a click in the middle of the frame, and the pointer moving on to the next control.
const recordingFor = (width, height) => compactRecording({ frame: { width, height }, scale: 1, duration: 6, cursors: { c1: { shape: "arrow" } } }, [
  ...Array.from({ length: 31 }, (_, step) => ({ t: (step / 30) * 0.9, type: "move", x: width * (0.2 + 0.3 * step / 30), y: height * (0.3 + 0.2 * step / 30), cursor: "c1" })),
  { t: 1, type: "down", x: width * 0.5, y: height * 0.5, button: "left", clicks: 1, source: "agent" }, { t: 1.1, type: "up", x: width * 0.5, y: height * 0.5, button: "left", source: "agent" },
  ...Array.from({ length: 31 }, (_, step) => ({ t: 1.2 + step / 30, type: "move", x: width * (0.5 + 0.1 * step / 30), y: height * (0.5 + 0.05 * step / 30), cursor: "c1" })),
]);
// stream, rewrite, decode and assemble work on a headline-size text (not role ui), so the reading-time,
// size and hold gates judge the words they stream, rewrite and decode in both 16:9 and 9:16.
const HEADLINE_TEXT = { op: "add_layer", layerType: "text", name: "prompt", properties: { x: 160, y: 480, width: 760, height: 120, text: "Find issues", fontSize: 96, textResize: "height", textAlign: "left", fill: "#EDEEF0" } };
const APP_CARD = { op: "add_layer", layerType: "rectangle", name: "app-card", properties: { x: 160, y: 120, width: 560, height: 340, radius: 32, fill: "#2A2D33" } };
// Layers an example names that the project does not have yet, added before it runs.
const EXTRA = {
  "type-on": [
    { op: "add_layer", layerType: "rectangle", name: "prompt-field", properties: { x: 160, y: 470, width: 760, height: 110, radius: 26, fill: "#1A1D22" } },
    { op: "add_layer", layerType: "text", name: "prompt", properties: { x: 200, y: 497, width: 600, height: 56, text: "Find issues", fontSize: 44, textResize: "width-height", textAlign: "left", fill: "#EDEEF0", role: "ui" } },
  ],
  stream: [HEADLINE_TEXT],
  rewrite: [HEADLINE_TEXT],
  decode: [HEADLINE_TEXT],
  assemble: [HEADLINE_TEXT],
  "accent-hit": [HEADLINE_TEXT],
  "light-sweep": [HEADLINE_TEXT],
  carry: [APP_CARD],
  cursor: [APP_CARD],
  "draw-on": [{ op: "add_layer", layerType: "path", name: "underline", properties: { x: 560, y: 600, width: 800, height: 40, path: "M0 20 C260 0 540 40 800 20", fillEnabled: false, stroke: "#FFFFFF", strokeWidth: 8 } }],
};

// The three ways the gate runs each move: wide, tall, and wide with reduced motion.
export const MOVE_SHAPES = [
  { label: "wide", width: 1920, height: 1080 },
  { label: "tall", width: 1080, height: 1920 },
  { label: "calm", width: 1920, height: 1080, reduced: true },
];

/** Every move in every shape (by hand). */
export const allMoveCases = () => MOVE_SHAPES.flatMap((shape) => MOVE_NAMES.map((name) => ({ name, ...shape })));

/** Each move once, taking the shapes in turn (each shape gets four moves). */
export const sampleMoveCases = () => MOVE_NAMES.map((name, index) => ({ name, ...MOVE_SHAPES[index % MOVE_SHAPES.length] }));

/**
 * Each case's move library example runs as written at width × height (reduced adds
 * reduced:true) and the scene then has no check errors, pixel checks included. Returns the failures.
 */
export async function movesGate(server, cases) {
  const api = movesApi(server);
  const failures = [];
  for (const { name, label, width, height, reduced = false } of cases) {
    const project = `${label}-${name}`;
    await setUpProject(api, project, { width, height });
    const uses = USES[name] ?? ["shot-a", "shot-b"];
    const hidden = ["shot-a", "shot-b", "phone"].filter((layer) => !uses.includes(layer));
    if (hidden.length) {
      const hide = await api.agent(project, "edit", { ops: hidden.map((layer) => ({ op: "delete_layer", layer })) });
      assert.equal(hide.isError, undefined, hide.text);
    }
    if (uses.includes("clip")) {
      const clip = await uploadClip(server, project, width, height);
      // kino reads the data a recording leaves next to its video when the layer is added.
      if (name === "screen-recording") await writeFile(path.join(server.dataDirectory, "media", `${clip.id}.recording.json`), JSON.stringify(recordingFor(width, height)));
      const added = await api.agent(project, "edit", { ops: [{ op: "add_layer", layerType: "video", name: "clip", properties: { src: clip.src, x: 0, y: 0, width, height } }] });
      assert.equal(added.isError, undefined, added.text);
    }
    if (EXTRA[name]) {
      const extra = await api.agent(project, "edit", { ops: EXTRA[name] });
      assert.equal(extra.isError, undefined, extra.text);
    }
    const example = await libraryExample(api, project, name);
    const made = await api.agent(project, "edit", { ops: [{ ...example, ...(reduced ? { reduced: true } : {}) }] });
    if (made.isError) { failures.push(`${project}: ${made.text}`); continue; }
    const check = await api.agent(project, "check");
    if (check.data.errors) failures.push(`${project}: ${check.text.split("\nRules:")[0]}`);
  }
  return failures;
}

// By hand: every move in every shape on a test server, printing every failure.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { startTestServer } = await import("../backend/media.test.support.mjs");
  const server = await startTestServer();
  try {
    const failures = await movesGate(server, allMoveCases());
    for (const failure of failures) console.log(failure);
    console.log(`${allMoveCases().length} moves checked, ${failures.length} failures`);
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    await server.stop();
  }
}
