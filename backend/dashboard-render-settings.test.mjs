// The dashboard's rendering settings through the real server: GET render/devices, the six render
// settings saved and read back, and an agent render whose answer says what drew and encoded it,
// with the dashboard's defaults and with the agent's own options.videoEncoder/videoQuality.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hasMediaTools, startTestServer } from "./media.test.support.mjs";
import { createDashboardRoutes } from "./dashboard-routes.mjs";
import { autoGraphics } from "./render-devices.mjs";

let server;
let key;
before(async () => {
  server = await startTestServer();
  const response = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  key = (await response.json()).key;
});
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "test-agent", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function dashboard(route, { method = "POST", body, review = true } = {}) {
  const response = await server.api(`/api/dashboard/${route}`, { method, body, headers: review ? { "x-kino-review": key } : {} });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("render/devices lists this computer's cards and video encoders, without a review key", async () => {
  const { status, body } = await dashboard("render/devices", { method: "GET", review: false });
  assert.equal(status, 200);
  assert.ok(["darwin", "linux", "wsl", "win32"].includes(body.graphics.platform));
  assert.ok(Array.isArray(body.graphics.cards));
  assert.equal(typeof body.graphics.canChoose, "boolean");
  assert.equal(body.graphics.saved, null, "no card is saved by name");
  // Auto is named after what renders started with this server's variables draw on (the server
  // runs with this test's environment).
  assert.equal(body.graphics.auto, autoGraphics({ platform: body.graphics.platform, env: process.env, cards: body.graphics.cards }));
  assert.ok(!/virtual display/i.test(body.graphics.auto ?? ""), "never a virtual display");
  const software = body.videoEncoders.find((entry) => entry.id === "software");
  assert.deepEqual([software.ffmpegEncoder, software.available], ["libx264", true]);
  assert.equal(body.autoVideoEncoder, body.videoEncoders.find((entry) => entry.available).id, "auto is the first that works");
  assert.deepEqual(Object.keys(body.overrides).sort(), ["card", "framesAtOnce", "graphics"]);
  assert.equal(body.lastRender, null);
  const again = await dashboard("render/devices?refresh=1", { method: "GET", review: false });
  assert.deepEqual(again.body.graphics.cards, body.graphics.cards, "detecting again finds the same cards");
});

test("the six rendering settings save, read back, and refuse what they cannot be", async () => {
  const change = { exports: { videoEncoder: "software", videoQuality: "high" },
    compute: { graphics: "A card that is not here", framesAtOnce: "auto", keepFreePercent: 30, renderCacheMegabytes: 256 } };
  const saved = await dashboard("settings", { method: "PUT", body: change });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = (await dashboard("settings", { method: "GET", review: false })).body.settings;
  assert.deepEqual({ videoEncoder: read.exports.videoEncoder, videoQuality: read.exports.videoQuality }, change.exports);
  for (const [name, value] of Object.entries(change.compute)) assert.equal(read.compute[name], value, name);
  assert.equal((await dashboard("cache", { method: "GET", review: false })).body.renderCache.limitBytes, 256 * 1024 * 1024);
  // A saved card that is not on this computer stays saved; the device list says it was not found.
  assert.deepEqual((await dashboard("render/devices", { method: "GET", review: false })).body.graphics.saved,
    { name: "A card that is not here", found: false, used: false });
  // A card's name in another case is found, as renders find it (render-devices.mjs namedCard), and
  // used only where cards can be chosen (Linux and WSL; on macOS and Windows it acts as Auto).
  const { cards, canChoose } = (await dashboard("render/devices", { method: "GET", review: false })).body.graphics;
  if (cards.length) {
    const lower = cards[0].name.toLowerCase();
    assert.equal((await dashboard("settings", { method: "PUT", body: { compute: { graphics: lower } } })).status, 200);
    assert.deepEqual((await dashboard("render/devices", { method: "GET", review: false })).body.graphics.saved, { name: lower, found: true, used: canChoose });
  }
  for (const [body, message] of [
    [{ exports: { videoEncoder: "hevc" } }, /video encoder is one of auto, software/],
    [{ exports: { videoQuality: "best" } }, /video quality is one of small, standard, high/],
    [{ compute: { framesAtOnce: 9 } }, /Frames at once is a whole number from 1 to 8/],
    [{ compute: { keepFreePercent: 2 } }, /from 5 to 60/],
    [{ compute: { renderCacheMegabytes: 10 } }, /from 64 to 65536/],
    [{ compute: { graphics: "two\nlines" } }, /graphics card is "auto", "processor"/],
  ]) {
    const refused = await dashboard("settings", { method: "PUT", body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.body.error, message);
  }
  const restored = await dashboard("settings", { method: "PUT", body: { exports: { videoEncoder: "auto", videoQuality: "standard" },
    compute: { graphics: "auto", framesAtOnce: 1, keepFreePercent: 20, renderCacheMegabytes: 512 } } });
  assert.equal(restored.status, 200);
});

test("on macOS and Windows a saved card's name is found but acts as Auto, since renders there cannot choose a card", async () => {
  const cards = [{ name: "AMD Radeon Pro 5500M", vendor: "AMD" }, { name: "Intel UHD Graphics 630", vendor: "Intel" }];
  for (const platform of ["darwin", "win32"]) {
    // The route alone, with this made-up computer's cards and a card saved by name.
    const routes = createDashboardRoutes({
      dashboard: { onEvent() {}, settings: () => ({ compute: { graphics: "amd radeon pro 5500m" } }) },
      json: (res, status, body) => Object.assign(res, { status, body }),
      listGraphics: async () => ({ platform, cards, canChoose: false, environment: {} }),
      listVideoEncoders: async () => [],
      env: {},
    });
    const res = {};
    await routes.handle({ method: "GET", headers: {} }, res, new URL("http://kino.test/api/dashboard/render/devices"), ["api", "dashboard", "render", "devices"]);
    assert.equal(res.status, 200, platform);
    assert.deepEqual(res.body.graphics.saved, { name: "amd radeon pro 5500m", found: true, used: false }, platform);
    assert.equal(res.body.graphics.auto, "AMD Radeon Pro 5500M", `${platform}: Auto is the separate card`);
  }
});

test("an agent render says what drew and encoded it; the agent's options win over the dashboard's", { skip: !hasMediaTools }, async () => {
  await agent("project", { action: "create", id: "rs", name: "Render settings", width: 320, height: 180, duration: 1 });
  await agent("edit", { project: "rs", ops: [{ op: "add_layer", type: "rectangle", name: "card", properties: { x: 100, y: 60, width: 120, height: 60, fill: "#3CC8B4" } }] });
  try {
    // The dashboard says: processor only, software encoder. Not given by the agent, both apply.
    assert.equal((await dashboard("settings", { method: "PUT", body: { exports: { videoEncoder: "software" }, compute: { graphics: "processor" } } })).status, 200);
    // A scene without effects is drawn by Resvg, on the processor, whatever the setting.
    const plain = await agent("render", { project: "rs", action: "start", format: "mp4", options: { duration: 0.5 }, wait: true });
    assert.match(plain.text, /drawn on the processor by Resvg \(no effect here needs the graphics card\); encoded with libx264, standard quality/);
    // "add" blending is drawn by Chromium, here without the card.
    const blended = await agent("edit", { project: "rs", ops: [{ op: "add_layer", type: "rectangle", name: "glow", properties: { x: 40, y: 40, width: 80, height: 40, fill: "#335577", blendMode: "add" } }] });
    assert.equal(blended.isError, undefined, blended.text);
    const first = await agent("render", { project: "rs", action: "start", format: "mp4", options: { duration: 0.5 }, wait: true });
    assert.equal(first.isError, undefined, first.text);
    assert.match(first.text, /drawn on the processor \(software[^)]*\), 1 frame at once; encoded with libx264, standard quality/);
    const devices = (await dashboard("render/devices", { method: "GET", review: false })).body;
    assert.equal(devices.lastRender.graphics.setting, "processor");
    assert.equal(devices.lastRender.graphics.card, false);
    assert.deepEqual(devices.lastRender.videoEncoder, { family: "software", ffmpegEncoder: "libx264", quality: "standard", bitrate: 12_000_000 });

    // The agent's own quality wins over the dashboard's (standard here).
    const second = await agent("render", { project: "rs", action: "start", format: "mp4", options: { duration: 0.5, videoQuality: "small" }, wait: true });
    assert.equal(second.isError, undefined, second.text);
    assert.match(second.text, /encoded with libx264, small quality/);
    assert.equal(second.data.files[0].videoEncoder.bitrate, 6_000_000);

    // A named encoder made for another computer is an error naming the ones that work here.
    const elsewhere = process.platform === "darwin" ? "nvenc" : "videotoolbox";
    const refused = await agent("render", { project: "rs", action: "start", format: "mp4", options: { duration: 0.5, videoEncoder: elsewhere }, wait: true });
    assert.match(refused.text, new RegExp(`The video encoder "${elsewhere}" does not work on this computer.*"software"`));
  } finally {
    await dashboard("settings", { method: "PUT", body: { exports: { videoEncoder: "auto" }, compute: { graphics: "auto" } } });
  }
});
