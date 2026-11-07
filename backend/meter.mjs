// Records how much text and image data each MCP tool call sends to the agent.
// Turned on by KINO_METER_FILE: one JSON line per call is appended to that file.
// Token numbers here are estimates of Claude's real tokens:
// - text: JSON (tool definitions, op lists, receipts) is about 2.1 characters per token, and
//   prose or markdown about 2.5, both measured on real Claude runs (October 2026). A text that
//   starts with { or [ counts as JSON.
// - images: one token per 28 × 28 pixel patch, after Claude shrinks a large image
//   (https://platform.claude.com/docs/en/build-with-claude/vision).
// Real totals still come from the agent's own usage report.
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

export const JSON_CHARS_PER_TOKEN = 2.1;
export const PROSE_CHARS_PER_TOKEN = 2.5;

/** True when the text is JSON or reads like it: its first non-space character is { or [. */
export function looksLikeJson(text) {
  return /^\s*[[{]/.test(String(text));
}

/** Estimated tokens for a text, at the JSON or the prose rate depending on what it looks like. */
export function estimateTextTokens(text) {
  const value = String(text);
  return Math.ceil(value.length / (looksLikeJson(value) ? JSON_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN));
}

/** Estimated tokens for JSON of the given length in characters. */
export function estimateJsonTokens(chars) {
  return Math.ceil(chars / JSON_CHARS_PER_TOKEN);
}

// Width and height from a PNG's header (IHDR), or null for other formats.
export function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Claude's image limits: the longest edge and the most patches it reads before shrinking an
// image. Claude 4.7 and later models (kino's agents) use the high-resolution tier.
export const IMAGE_TIERS = {
  high: { maxEdge: 2576, maxTokens: 4784 },
  standard: { maxEdge: 1568, maxTokens: 1568 },
};

const patches = (width, height) => Math.ceil(width / 28) * Math.ceil(height / 28);

// Rounds a .5 to the even neighbour, as the API does when it picks the short edge.
function roundHalfToEven(value) {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The size Claude shrinks an image to: the largest size with the same shape whose edges
 * and patch count fit the tier. Follows Anthropic's reference implementation
 * (https://platform.claude.com/docs/en/build-with-claude/vision-coordinates).
 */
export function claudeImageSize({ width, height }, tier = "high") {
  const { maxEdge, maxTokens } = IMAGE_TIERS[tier] ?? IMAGE_TIERS.high;
  const fits = (w, h) => Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && patches(w, h) <= maxTokens;
  if (fits(width, height)) return { width, height };
  if (height > width) {
    const turned = claudeImageSize({ width: height, height: width }, tier);
    return { width: turned.height, height: turned.width };
  }
  // Search along the long edge for the largest size that fits.
  const aspect = width / height;
  const shortEdge = (long) => Math.max(roundHalfToEven(long / aspect), 1);
  let low = 1;
  let high = width;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle, shortEdge(middle))) low = middle;
    else high = middle;
  }
  return { width: low, height: shortEdge(low) };
}

/** Tokens an image costs Claude: ⌈width / 28⌉ × ⌈height / 28⌉ after shrinking. */
export function estimateImageTokens(size, tier = "high") {
  const { width, height } = claudeImageSize(size, tier);
  return patches(width, height);
}

// Sizes of one tool answer: text characters, images, and estimated tokens.
export function measureResult(result) {
  let textChars = 0;
  let tokens = 0;
  const images = [];
  for (const item of result?.content ?? []) {
    if (item.type === "text") {
      textChars += item.text.length;
      tokens += estimateTextTokens(item.text);
    }
    if (item.type === "image") {
      const size = pngSize(Buffer.from(item.data, "base64"));
      if (size) tokens += estimateImageTokens(size);
      images.push(size ?? { bytes: Math.floor((item.data.length * 3) / 4) });
    }
  }
  if (result?.structuredContent) {
    const chars = JSON.stringify(result.structuredContent).length;
    textChars += chars;
    tokens += estimateJsonTokens(chars);
  }
  return { textChars, images, tokens };
}

// Wraps server.registerTool so every tool registered afterwards is measured.
export function meterTools(server, file = process.env.KINO_METER_FILE) {
  if (!file) return;
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => register(name, config, async (input, context) => {
    const started = performance.now();
    const output = await handler(input, context);
    const inputChars = JSON.stringify(input ?? {}).length;
    const measured = measureResult(output);
    const line = {
      at: new Date().toISOString(),
      tool: name,
      ms: Math.round(performance.now() - started),
      inputChars,
      inputTokens: estimateJsonTokens(inputChars),
      outputChars: measured.textChars,
      outputTokens: measured.tokens,
      images: measured.images,
      isError: Boolean(output?.isError),
    };
    try { appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 }); }
    catch (error) { console.error(`[kino meter] ${error.message}`); }
    return output;
  });
}

// Sizes of the tool list an agent loads before its first call. Tool definitions are JSON,
// so their tokens use the JSON rate.
export function measureToolDefinitions(tools) {
  const rows = tools.map((tool) => {
    const definitionChars = JSON.stringify(tool).length;
    return { name: tool.name, descriptionChars: (tool.description ?? "").length, definitionChars, definitionTokens: estimateJsonTokens(definitionChars) };
  });
  const definitionChars = rows.reduce((sum, row) => sum + row.definitionChars, 0);
  return {
    tools: rows.length,
    definitionChars,
    definitionTokens: estimateJsonTokens(definitionChars),
    longestDescription: rows.reduce((best, row) => row.descriptionChars > best.descriptionChars ? row : best, rows[0] ?? { descriptionChars: 0 }),
    rows,
  };
}
