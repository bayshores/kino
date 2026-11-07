import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { claudeImageSize, estimateImageTokens, estimateTextTokens, measureResult, measureToolDefinitions, meterTools, pngSize } from "./meter.mjs";

test("image tokens are 28 × 28 pixel patches, after Claude shrinks a large image", () => {
  assert.equal(estimateImageTokens({ width: 200, height: 200 }), 64);
  assert.equal(estimateImageTokens({ width: 1000, height: 1000 }), 1296);
  // A 1080p frame fits the high-resolution tier as it is: 69 × 39 patches.
  assert.equal(estimateImageTokens({ width: 1920, height: 1080 }), 2691);
  // 4K is shrunk until the patches fit 4,784.
  assert.deepEqual(claudeImageSize({ width: 3840, height: 2160 }), { width: 2576, height: 1449 });
  assert.equal(estimateImageTokens({ width: 3840, height: 2160 }), 4784);
  // The standard tier (older models) has a 1,568-pixel edge and 1,568 patches.
  assert.deepEqual(claudeImageSize({ width: 1920, height: 1080 }, "standard"), { width: 1456, height: 819 });
  assert.equal(estimateImageTokens({ width: 1920, height: 1080 }, "standard"), 1560);
  // A tall page keeps its shape.
  assert.deepEqual(claudeImageSize({ width: 1075, height: 1520 }, "standard"), { width: 924, height: 1307 });
});

test("text tokens use the JSON rate for JSON and the prose rate for everything else", () => {
  assert.equal(estimateTextTokens("x".repeat(25)), 10);
  assert.equal(estimateTextTokens(`{"a":"${"x".repeat(15)}"}`), Math.ceil(23 / 2.1));
  assert.equal(estimateTextTokens("  [1,2]"), Math.ceil(7 / 2.1));
  assert.equal(estimateTextTokens(""), 0);
});

test("a tool answer is measured by its text and its PNG images", () => {
  const png = createCanvas(480, 270).toBuffer("image/png");
  assert.deepEqual(pngSize(png), { width: 480, height: 270 });
  const measured = measureResult({ content: [
    { type: "text", text: "x".repeat(35) },
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
  ] });
  assert.equal(measured.textChars, 35);
  assert.deepEqual(measured.images, [{ width: 480, height: 270 }]);
  // 35 characters of prose (14 tokens) and 18 × 10 patches (180 tokens).
  assert.equal(measured.tokens, 14 + 180);
});

test("metered tools append one line per call and still return the real answer", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kino-meter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "meter.jsonl");
  const handlers = new Map();
  const server = { registerTool(name, config, handler) { handlers.set(name, handler); } };
  meterTools(server, file);
  server.registerTool("echo", {}, async ({ text }) => ({ content: [{ type: "text", text }] }));
  server.registerTool("fail", {}, async () => ({ isError: true, content: [{ type: "text", text: "refused" }] }));
  assert.deepEqual(await handlers.get("echo")({ text: "hello" }), { content: [{ type: "text", text: "hello" }] });
  await handlers.get("fail")({});
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ tool, outputChars, isError }) => ({ tool, outputChars, isError })), [
    { tool: "echo", outputChars: 5, isError: false },
    { tool: "fail", outputChars: 7, isError: true },
  ]);
});

test("without a meter file, tools are registered unchanged", () => {
  const handler = async () => ({ content: [] });
  let registered;
  const server = { registerTool(name, config, given) { registered = given; } };
  meterTools(server, undefined);
  server.registerTool("plain", {}, handler);
  assert.equal(registered, handler);
});

test("tool definitions are measured whole, with the longest description named", () => {
  const report = measureToolDefinitions([
    { name: "a", description: "short", inputSchema: { type: "object" } },
    { name: "b", description: "a much longer description", inputSchema: { type: "object" } },
  ]);
  assert.equal(report.tools, 2);
  assert.equal(report.longestDescription.name, "b");
  assert.equal(report.definitionChars, report.rows[0].definitionChars + report.rows[1].definitionChars);
  assert.equal(report.definitionTokens, Math.ceil(report.definitionChars / 2.1));
  assert.equal(report.rows[0].definitionTokens, Math.ceil(report.rows[0].definitionChars / 2.1));
});
