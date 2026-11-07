// The dashboard's render settings (exports.videoEncoder and videoQuality; compute.graphics,
// framesAtOnce, keepFreePercent and renderCacheMegabytes): a change is checked strictly, and a
// saved dashboard.json is read field by field, so a file from an older or newer kino, or with
// one bad field, keeps the approvals, the approval numbers, the hold and every valid setting.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboard, defaultSettings, loadSettings, mergeSettings } from "./agent/dashboard.mjs";
import { withVideoDefaults } from "./export-batches.mjs";

const refused = (change, message) => assert.throws(() => mergeSettings(defaultSettings(), change), (error) => error.status === 400 && message.test(error.message));

test("the six render settings have their defaults", () => {
  const settings = defaultSettings();
  assert.deepEqual(settings.exports, { format: "mp4", fps: 30, folder: "", videoEncoder: "auto", videoQuality: "standard" });
  assert.deepEqual(settings.compute, { draftWidth: 960, frameCacheMegabytes: 1024, graphics: "auto", framesAtOnce: 1, keepFreePercent: 20, renderCacheMegabytes: 512,
    previewCache: true, previewCacheMegabytes: 2048 });
});

test("each render setting takes its valid values", () => {
  for (const videoEncoder of ["auto", "software", "videotoolbox", "nvenc", "qsv", "amf", "vaapi"])
    assert.equal(mergeSettings(defaultSettings(), { exports: { videoEncoder } }).exports.videoEncoder, videoEncoder);
  for (const videoQuality of ["small", "standard", "high"])
    assert.equal(mergeSettings(defaultSettings(), { exports: { videoQuality } }).exports.videoQuality, videoQuality);
  for (const graphics of ["auto", "processor", "NVIDIA GeForce RTX 4090", "x".repeat(120)])
    assert.equal(mergeSettings(defaultSettings(), { compute: { graphics } }).compute.graphics, graphics);
  for (const framesAtOnce of [1, 4, 5, 7, 8, "auto"])
    assert.equal(mergeSettings(defaultSettings(), { compute: { framesAtOnce } }).compute.framesAtOnce, framesAtOnce);
  for (const keepFreePercent of [5, 20, 60])
    assert.equal(mergeSettings(defaultSettings(), { compute: { keepFreePercent } }).compute.keepFreePercent, keepFreePercent);
  for (const renderCacheMegabytes of [64, 512, 65_536])
    assert.equal(mergeSettings(defaultSettings(), { compute: { renderCacheMegabytes } }).compute.renderCacheMegabytes, renderCacheMegabytes);
  const preview = mergeSettings(defaultSettings(), { compute: { previewCache: false, previewCacheMegabytes: 512 } }).compute;
  assert.deepEqual([preview.previewCache, preview.previewCacheMegabytes], [false, 512]);
  // A change names only what it changes; the rest stays.
  const both = mergeSettings(defaultSettings(), { exports: { videoQuality: "high" }, compute: { framesAtOnce: "auto" } });
  assert.equal(both.exports.format, "mp4");
  assert.equal(both.compute.renderCacheMegabytes, 512);
});

test("the dashboard's video encoder and quality fill in an MP4's options, whatever the case of its format", () => {
  const defaults = { videoEncoder: "software", videoQuality: "high" };
  // /api/export passes the format as given, and exportScene lowercases it, so "MP4" is an MP4.
  for (const format of ["mp4", "MP4", "Mp4"])
    assert.deepEqual(withVideoDefaults({ format }, defaults), { format, videoEncoder: "software", videoQuality: "high" }, format);
  assert.deepEqual(withVideoDefaults({ profile: "mp4" }, defaults), { profile: "mp4", videoEncoder: "software", videoQuality: "high" });
  // The agent's own options win; other formats, no format (a PNG) and the fallback profile get nothing.
  assert.deepEqual(withVideoDefaults({ format: "MP4", videoQuality: "small" }, defaults), { format: "MP4", videoEncoder: "software", videoQuality: "small" });
  for (const options of [{ format: "WEBM" }, { format: "gif" }, {}, { profile: "mp4.alt" }])
    assert.deepEqual(withVideoDefaults(options, defaults), options, JSON.stringify(options));
});

test("each render setting refuses a wrong value with a plain message", () => {
  refused({ exports: { videoEncoder: "h264_nvenc" } }, /^The video encoder is one of auto, software, videotoolbox, nvenc, qsv, amf, vaapi\.$/);
  refused({ exports: { videoEncoder: null } }, /video encoder is one of/);
  refused({ exports: { videoQuality: "best" } }, /^The video quality is one of small, standard, high\.$/);
  for (const graphics of ["", "   ", "x".repeat(121), "NVIDIA\nRTX", "card\u0000", 3, null])
    refused({ compute: { graphics } }, /^The graphics card is "auto", "processor", or a card's name \(1 to 120 characters, on one line\)\.$/);
  for (const framesAtOnce of [0, 9, 2.5, "4", "Auto", null])
    refused({ compute: { framesAtOnce } }, /^Frames at once is a whole number from 1 to 8, or "auto"\.$/);
  for (const keepFreePercent of [4, 61, 20.5, "20"])
    refused({ compute: { keepFreePercent } }, /^The memory to leave free \(a percent\) must be a whole number from 5 to 60\.$/);
  for (const renderCacheMegabytes of [63, 65_537, 100.5, "512"])
    refused({ compute: { renderCacheMegabytes } }, /^The render cache size \(in megabytes\) must be a whole number from 64 to 65536\.$/);
  refused({ compute: { previewCache: "off" } }, /^compute\.previewCache is true or false\.$/);
  // A change is strict: unknown fields inside a section are refused too, naming the ones there are.
  refused({ compute: { framesAtonce: 2 } }, /^Unknown setting "compute\.framesAtonce"\. The compute settings are draftWidth, frameCacheMegabytes, graphics, framesAtOnce, keepFreePercent, renderCacheMegabytes, previewCache, previewCacheMegabytes\.$/);
  refused({ exports: "mp4" }, /^"exports" must be an object of settings\.$/);
  refused({ rendering: {} }, /^Unknown setting "rendering"\.$/);
});

test("reading saved settings keeps every valid field and drops each unknown or invalid one", () => {
  const { settings, dropped } = loadSettings({
    approvals: { "share-link": "allow", "launch-rocket": "allow" },
    exports: { format: "webm", videoQuality: "huge", videoEncoder: "nvenc", sharpen: true },
    compute: { graphics: "processor", framesAtOnce: 12, keepFreePercent: 30, renderCacheMegabytes: 2048 },
    channels: "yes",
    theme: "dark",
  });
  assert.equal(settings.approvals["share-link"], "allow");
  assert.deepEqual(settings.exports, { format: "webm", fps: 30, folder: "", videoEncoder: "nvenc", videoQuality: "standard" });
  assert.deepEqual(settings.compute, { draftWidth: 960, frameCacheMegabytes: 1024, graphics: "processor", framesAtOnce: 1, keepFreePercent: 30, renderCacheMegabytes: 2048, previewCache: true, previewCacheMegabytes: 2048 });
  assert.equal(settings.channels, false);
  assert.deepEqual(dropped.map((entry) => entry.split(":")[0]).sort(),
    ["approvals.launch-rocket", "channels", "compute.framesAtOnce", "exports.sharpen", "exports.videoQuality", "theme"]);
  assert.match(dropped.find((entry) => entry.startsWith("theme")), /not a setting this version of kino knows/);
  assert.match(dropped.find((entry) => entry.startsWith("compute.framesAtOnce")), /whole number from 1 to 8/);
  assert.deepEqual(loadSettings(undefined), { settings: defaultSettings(), dropped: [] });
  assert.deepEqual(loadSettings({ compute: "fast" }).dropped, ["compute: not an object of settings"]);
});

async function dataFolder(t) {
  const root = await mkdtemp(path.join(tmpdir(), "kino-dashboard-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDirectory = path.join(root, "agent");
  await mkdir(agentDirectory, { recursive: true });
  return agentDirectory;
}

const agentState = { update: async () => {} };
const savedApprovals = [
  { id: "Q7", kind: "final-render", kinds: ["final-render"], projectId: "p1", verb: "render", input: {}, match: "[]", status: "pending", summary: "render 900 frames", createdAt: "2026-10-19T10:00:00.000Z", answeredAt: null, note: "", result: null },
  { id: "Q8", kind: "share-link", kinds: ["share-link"], projectId: "p1", verb: "project", input: {}, match: "[]", status: "denied", summary: "share", createdAt: "2026-10-19T10:01:00.000Z", answeredAt: "2026-10-19T10:02:00.000Z", note: "", result: null },
];
const savedHold = { on: true, since: "2026-10-19T10:03:00.000Z", note: "lunch" };

// Loads a dashboard.json written as `stored`, and what it warned.
async function load(t, stored) {
  const agentDirectory = await dataFolder(t);
  await writeFile(path.join(agentDirectory, "dashboard.json"), JSON.stringify(stored));
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const dashboard = await createDashboard({ agentDirectory, agentState });
    return { dashboard, warnings, agentDirectory };
  } finally { console.warn = warn; }
}

function assertKept(dashboard) {
  assert.deepEqual(dashboard.approvals().map((entry) => [entry.id, entry.status]), [["Q7", "pending"], ["Q8", "denied"]]);
  assert.deepEqual(dashboard.hold(), savedHold);
  assert.equal(dashboard.pendingCount(), 1);
}

test("a dashboard.json from an older kino (no render settings) keeps everything and gets the defaults", async (t) => {
  const older = { approvals: { "share-link": "allow" }, limits: { finalRenderFrames: 900, importMegabytes: 50 }, exports: { format: "gif", fps: 24, folder: "" }, compute: { draftWidth: 640, frameCacheMegabytes: 256 }, channels: true };
  const { dashboard, warnings } = await load(t, { settings: older, approvals: savedApprovals, nextApproval: 9, hold: savedHold });
  assert.deepEqual(warnings, []);
  assertKept(dashboard);
  const settings = dashboard.settings();
  assert.deepEqual(settings.limits, { ...older.limits, skipBoardUnder: 8, skipRoughUnder: 15, skipColorUnder: 15, skipSoundUnder: 15 });
  assert.deepEqual(settings.exports, { format: "gif", fps: 24, folder: "", videoEncoder: "auto", videoQuality: "standard" });
  assert.deepEqual(settings.compute, { draftWidth: 640, frameCacheMegabytes: 256, graphics: "auto", framesAtOnce: 1, keepFreePercent: 20, renderCacheMegabytes: 512, previewCache: true, previewCacheMegabytes: 2048 });
  assert.equal(settings.approvals["share-link"], "allow");
  assert.equal(settings.channels, true);
});

test("a dashboard.json from a newer kino (unknown fields) keeps everything it knows, with one warning", async (t) => {
  const newer = {
    approvals: { "share-link": "deny", "publish-site": "ask" },
    exports: { format: "mp4", fps: 60, folder: "", videoEncoder: "videotoolbox", videoQuality: "high", tenBit: true },
    compute: { draftWidth: 480, frameCacheMegabytes: 2048, graphics: "Apple M2 Max", framesAtOnce: "auto", keepFreePercent: 10, renderCacheMegabytes: 4096, renderFarm: "office" },
    channels: false,
    sound: { volume: 0.5 },
  };
  const { dashboard, warnings, agentDirectory } = await load(t, { settings: newer, approvals: savedApprovals, nextApproval: 9, hold: savedHold, newerThing: [1] });
  assertKept(dashboard);
  assert.equal(warnings.length, 1, "one warning lists every field it dropped");
  assert.match(warnings[0], /^\[kino\] Some saved dashboard settings were not used, so their defaults apply: /);
  for (const name of ["approvals.publish-site", "exports.tenBit", "compute.renderFarm", "sound"]) assert.ok(warnings[0].includes(name), name);
  const settings = dashboard.settings();
  assert.deepEqual(settings.exports, { format: "mp4", fps: 60, folder: "", videoEncoder: "videotoolbox", videoQuality: "high" });
  assert.deepEqual(settings.compute, { draftWidth: 480, frameCacheMegabytes: 2048, graphics: "Apple M2 Max", framesAtOnce: "auto", keepFreePercent: 10, renderCacheMegabytes: 4096, previewCache: true, previewCacheMegabytes: 2048 });
  assert.equal(settings.approvals["share-link"], "deny");
  assert.equal(Object.hasOwn(settings.approvals, "publish-site"), false);
  // The next approval keeps counting from the saved number.
  const asked = await dashboard.request({ kinds: [{ kind: "delete-scene", summary: "delete scene s2" }], projectId: "p1", verb: "edit", input: { ops: [] } });
  assert.equal(asked.id, "Q9");
  await dashboard.flush();
  const written = JSON.parse(await readFile(path.join(agentDirectory, "dashboard.json"), "utf8"));
  assert.equal(written.settings.compute.renderCacheMegabytes, 4096);
  assert.equal(written.approvals.length, 3);
});

test("a dashboard.json with one invalid field drops only that field", async (t) => {
  const stored = {
    approvals: { "share-link": "allow" },
    exports: { format: "webm", fps: 25, folder: "", videoEncoder: "auto", videoQuality: "small" },
    compute: { draftWidth: 640, frameCacheMegabytes: 512, graphics: "NVIDIA GeForce RTX 4090", framesAtOnce: 99, keepFreePercent: 25, renderCacheMegabytes: 1024 },
    channels: true,
  };
  const { dashboard, warnings } = await load(t, { settings: stored, approvals: savedApprovals, nextApproval: 9, hold: savedHold });
  assertKept(dashboard);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /compute\.framesAtOnce: Frames at once is a whole number from 1 to 8, or "auto"$/);
  const settings = dashboard.settings();
  assert.deepEqual(settings.exports, stored.exports);
  assert.deepEqual(settings.compute, { ...stored.compute, framesAtOnce: 1, previewCache: true, previewCacheMegabytes: 2048 });
  assert.equal(settings.approvals["share-link"], "allow");
  assert.equal(settings.channels, true);
});

test("a missing or unreadable approval number never reuses one in the saved list", async (t) => {
  const { dashboard } = await load(t, { settings: { compute: { framesAtOnce: "lots" } }, approvals: savedApprovals, nextApproval: "nine", hold: savedHold });
  assertKept(dashboard);
  const asked = await dashboard.request({ kinds: [{ kind: "delete-scene", summary: "delete scene s2" }], projectId: "p1", verb: "edit", input: { ops: [1] } });
  assert.equal(asked.id, "Q9");
});

test("a change through updateSettings stays strict and leaves the saved settings alone when refused", async (t) => {
  const { dashboard } = await load(t, { settings: {}, approvals: [], nextApproval: 1, hold: { on: false } });
  await assert.rejects(dashboard.updateSettings({ compute: { renderCacheMegabytes: 10 } }), /render cache size \(in megabytes\) must be a whole number from 64 to 65536/);
  assert.equal(dashboard.settings().compute.renderCacheMegabytes, 512);
  const changed = await dashboard.updateSettings({ compute: { renderCacheMegabytes: 128, graphics: "processor" } });
  assert.equal(changed.compute.renderCacheMegabytes, 128);
  assert.equal(changed.compute.graphics, "processor");
});
