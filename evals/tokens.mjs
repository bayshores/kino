// Codex token counts and dollars for evals/run.mjs. Codex reports its usage as one running
// total per session; dollars come from evals/prices.json (dated list prices), and are null
// when a model has no confirmed price.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PRICES_FILE = path.resolve(here, "prices.json");

export function loadPrices(file = PRICES_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function withTotal(row) {
  row.total = row.fresh + row.cacheWrite + row.cacheRead + row.output;
  return row;
}

// Parses a JSONL text into events, skipping lines that are not JSON.
export function parseEvents(text) {
  const events = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* not an event line */ }
  }
  return events;
}

/**
 * Codex `exec --json` events → token columns.
 *
 * `turn.completed.usage` is a running total for the session, so only the LAST one counts
 * (adding them up would count early tokens again). Codex's input includes cached and
 * cache-write tokens, and its output includes reasoning, so fresh input is
 * input − cached − cache_write.
 */
export function codexUsage(events, { model = null } = {}) {
  let last = null, turnsCompleted = 0, toolCalls = 0, webSearches = 0;
  for (const event of events) {
    if (event.type === "turn.completed" && event.usage) { last = event.usage; turnsCompleted += 1; }
    if (event.type === "item.completed" && ["command_execution", "mcp_tool_call", "file_change"].includes(event.item?.type)) toolCalls += 1;
    if (event.type === "item.completed" && event.item?.type === "web_search") webSearches += 1;
  }
  const input = last?.input_tokens ?? 0;
  const cacheRead = last?.cached_input_tokens ?? 0;
  const cacheWrite = last?.cache_write_input_tokens ?? 0;
  const row = withTotal({
    fresh: Math.max(0, input - cacheRead - cacheWrite),
    cacheWrite,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead,
    output: last?.output_tokens ?? 0,
    reasoning: last?.reasoning_output_tokens ?? 0,
    total: 0,
  });
  row.agentCostUsd = null;
  row.peakRequest = null;
  return {
    agent: "codex",
    source: last ? "last turn.completed" : "none",
    totals: { ...row },
    perModel: last ? { [model ?? "unknown"]: row } : {},
    rawUsage: last,
    turnsCompleted,
    toolCalls,
    webSearches,
    // Codex's turns, for the --max-turns limit: its tool calls (command runs, MCP tool calls,
    // file changes). One `codex exec` is a single turn.completed however much it does, so
    // turnsCompleted cannot be compared with Claude Code's turns; a tool call is the nearest
    // thing to one of Claude's turns (a model response that asks for tools). Codex cannot stop
    // itself at the limit, so the count is made after the run.
    turns: toolCalls,
    peakContext: null,
    agentCostUsd: null,
    model,
  };
}

// Finds a model's price row: the exact id, the id without a "[1m]"-style suffix or a date
// suffix, or null.
export function priceRow(prices, model) {
  if (!model) return null;
  const table = prices.models ?? {};
  const plain = String(model).replace(/\[[^\]]*\]$/, "");
  return table[model] ?? table[plain] ?? table[plain.replace(/-\d{8}$/, "")] ?? null;
}

/**
 * Dollars for one usage (from claudeUsage or codexUsage), from the price table.
 * Returns { dollars, perModel, unpricedModels, approximate, notes }. `dollars` is null when
 * any model with tokens has no confirmed price.
 */
export function priceUsage(usage, prices, { cacheTtl = "5m" } = {}) {
  const perModel = {};
  const unpricedModels = [];
  const notes = [];
  let dollars = 0, approximate = false;
  for (const [model, row] of Object.entries(usage.perModel ?? {})) {
    if (!row.total) { perModel[model] = 0; continue; }
    const price = priceRow(prices, model);
    const rates = price && [price.input, price.cacheRead, price.output].every((value) => typeof value === "number") ? price : null;
    if (!rates) { unpricedModels.push(model); perModel[model] = null; continue; }
    // OpenAI lists one cache-write rate; Anthropic lists 5-minute and 1-hour rates.
    const write5m = rates.cacheWrite ?? rates.cacheWrite5m;
    const write1h = rates.cacheWrite ?? rates.cacheWrite1h;
    const writeDefault = rates.cacheWrite ?? (cacheTtl === "1h" ? rates.cacheWrite1h : rates.cacheWrite5m);
    if ([write5m, write1h, writeDefault].some((value) => typeof value !== "number") && row.cacheWrite) {
      unpricedModels.push(model); perModel[model] = null; continue;
    }
    const split = row.cacheWrite5m + row.cacheWrite1h === row.cacheWrite;
    const writeCost = split ? row.cacheWrite5m * write5m + row.cacheWrite1h * write1h : row.cacheWrite * writeDefault;
    const cost = (row.fresh * rates.input + writeCost + row.cacheRead * rates.cacheRead + row.output * rates.output) / 1e6;
    perModel[model] = cost;
    dollars += cost;
    if (rates.longContext) {
      // Long-context prices apply per request. Claude gives the largest request per model;
      // Codex gives only a running total, so its long-context tier can never be ruled out.
      const over = rates.longContext.overInputTokens;
      if (row.peakRequest == null || row.peakRequest > over) {
        approximate = true;
        notes.push(`${model}: priced at the lower tier; requests over ${over} input tokens cost more and could not be counted exactly.`);
      }
    }
  }
  return { dollars: unpricedModels.length ? null : dollars, perModel, unpricedModels, approximate, notes };
}
