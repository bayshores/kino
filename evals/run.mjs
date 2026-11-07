// Runs kino's internal test briefs (evals/briefs.json) with a real coding agent and records
// what each run cost: tokens, tool calls, time, and what was made.
//
// Each run gets its own kino server and data folder, so runs never touch your projects.
// The agent works in an empty temporary folder (its own Git repository, so no project
// instructions from this checkout reach it) that holds only the kino skill. Claude gets
// kino's MCP tools and the Skill tool; Codex gets kino's MCP tools and a read-only shell.
// The agent starts in an isolated environment (evals/agent-env.mjs): an empty HOME,
// CLAUDE_CONFIG_DIR and CODEX_HOME of its own, and only an API key to log in with: ANTHROPIC_API_KEY
// for Claude, CODEX_API_KEY for Codex. Your own Claude or Codex login is never used.
//
// Usage:
//   node evals/run.mjs --brief promo-01 [--brief clip-02 | --brief all] [--runs 1]
//                      [--agent claude|codex] [--model <name>] [--max-turns 60]
//                      [--watch]                print each tool call and message as it happens
//                      [--out <folder>]         the batch folder (default .local/evals/<time>-<agent>)
// A brief can list `media` the agent works with (made with FFmpeg or copied from evals/assets
// for each run) and `requires` features the video must have (audio, captions, beats). Every
// run is also scored on the quality gates: finished, a full-size, full-length export, and 0
// errors from the same check that blocks a final render.
// These one-shot briefs are told that no one will answer questions (prompt version 2).
// Results: .local/evals/<time>/<brief>-<agent>-<n>/result.json and a summary.json.
// Direction briefs (direction: true, B1) test the brief interview instead: the agent gets only
// the person's request, and the harness plays the person, writing one scripted reply after
// each finished turn (evals/direction.mjs pickReply) on Claude Code's stream-json input. The
// run writes transcript.json next to result.json and passes when checkDirection() does (at
// most 3 questions, one per message, the path and the open question first, the lines the
// request left open asked, exact quotes, a 5–8 line playback, at most 10 replies asked for,
// the brief saved before the playback, kino's reply count matching, and the brief confirmed).
// Claude only.
// Board briefs (board: true, B4b) are direction briefs that go on to the storyboard: the
// playback's answer asks for the board, so the run goes on to kino's board ask (or a turn that
// asks nothing); the board's open items asked before it get the brief's boardReply ("your
// call"). It passes when checkBoard() passes too (evals/board.mjs: kino's ask sent
// as written, with "My calls" and a true fresh-eyes line, and at most one question message
// between the playback and the ask).
// --max-turns limits each message separately with streamed input (checked with claude
// 2.1.306): a message that goes over ends with an error_max_turns result, and the
// conversation still takes the next reply.
// Brand-kit briefs (kit: true, A4): the harness makes the project and loads the brand kit
// before the agent starts; a run passes when it finishes with a full-length export and
// check shows 0 errors, none of them waived (waived warnings, such as brand fonts, are fine).
// Re-read saved Claude token numbers: node evals/run.mjs --rescore .local/evals/<time>
import { fork, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegCommand, probeMedia } from "../backend/media-probe.mjs";
import { estimateTextTokens, measureToolDefinitions } from "../backend/meter.mjs";
import { listKinoTools } from "../scripts/mcp-budget.mjs";
import { RULES } from "../engine/quality/index.js";
import { API_KEY_VARIABLES, isolatedEnv, makeTrialDirs } from "./agent-env.mjs";
import { codexUsage, loadPrices, parseEvents, priceUsage } from "./tokens.mjs";
import { checkBoard, isBoardAsk } from "./board.mjs";
import { REPLY_LIMIT, checkDirection, pickReply } from "./direction.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { brands, briefs } = JSON.parse(readFileSync(path.join(root, "evals/briefs.json"), "utf8"));
// Version 2 of the one-shot prompt adds "No one will answer questions…", because the direction
// guide (B1) asks the person questions; results made with version 1 lack `prompt`.
const PROMPT_VERSION = 2;
// A direction run ends after this long, whatever the agent is doing.
const DIRECTION_TIME_LIMIT_MS = 10 * 60_000;
// A board run also imports the clip, builds the storyboard and looks at it.
const BOARD_TIME_LIMIT_MS = 20 * 60_000;
const CODEX_DIRECTION = "direction briefs run with --agent claude only; codex replies are not wired yet.";

// Rules that can report an error or hold a final render: waiving one does not count as 0 errors for a brand-kit brief.
const ERROR_RULES = new Set([...RULES.filter((entry) => entry.level === "error" || entry.final).map((entry) => entry.code), "missing_media", "past_scene_end", "av_offset"]);
// The A4 brand-kit target: finished, the whole video exported, 0 check errors and no error waived.
export function kitPassed(brief, result) {
  const fullLength = result.export?.duration != null && Math.abs(result.export.duration - brief.duration) <= 0.5;
  const waivedErrors = (result.check?.waivedFindings ?? []).filter((entry) => ERROR_RULES.has(entry.rule));
  return Boolean(result.agentReport?.finished && fullLength && result.check?.errors === 0 && !waivedErrors.length);
}

/** The command line as options. Exported for tests/direction-eval.test.mjs. */
export function parseArgs(argv) {
  const options = { briefs: [], runs: 1, agent: "claude", model: null, maxTurns: 60 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--brief") options.briefs.push(...value().split(","));
    else if (flag === "--runs") options.runs = Number(value());
    else if (flag === "--agent") options.agent = value();
    else if (flag === "--model") options.model = value();
    else if (flag === "--max-turns") options.maxTurns = Number(value());
    else if (flag === "--watch") options.watch = true;
    else if (flag === "--out") options.out = path.resolve(value());
    else throw new Error(`Unknown option ${flag}.`);
  }
  // "all" leaves the direction briefs out where they cannot run: with Codex (its replies are
  // not wired yet).
  if (options.briefs.includes("all"))
    options.briefs = briefs.filter((brief) => !(brief.direction && options.agent === "codex")).map((brief) => brief.id);
  if (!options.briefs.length) throw new Error("Choose at least one --brief (or --brief all).");
  if (!["claude", "codex"].includes(options.agent)) throw new Error("--agent must be claude or codex.");
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive whole number.");
  return options;
}

// A one-shot run has no one to answer a stop (the storyboard, rough cut, color and sound passes),
// and an agent cannot let a stop pass by itself. So the person running the eval sets the four
// stops to allow, as a person would in kino Settings, before the server starts: each stop is then
// recorded as allowed by the person's settings. Direction runs keep the defaults (the harness
// plays the person).
export async function prepareSettings(dataDirectory, brief) {
  if (brief.direction) return;
  const approvals = Object.fromEntries(["board", "rough", "color", "sound"].map((kind) => [`checkpoint-${kind}`, "allow"]));
  await mkdir(path.join(dataDirectory, "agent"), { recursive: true });
  await writeFile(path.join(dataDirectory, "agent", "dashboard.json"), JSON.stringify({ settings: { approvals } }));
}

// Starts a private kino server and resolves with its address once it is listening.
function startServer(dataDirectory) {
  const env = { ...process.env, MOTION_DATA_DIR: dataDirectory, MOTION_HOST: "127.0.0.1", MOTION_API_PORT: "0" };
  for (const key of ["KINO_PUBLIC_URL", "KINO_OWNER_TOKEN", "KINO_DESKTOP"]) delete env[key];
  const child = fork(path.join(root, "backend/index.mjs"), [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-4000); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`kino server did not start.\n${errors}`)), 30_000);
    child.on("message", (message) => {
      if (message?.type !== "kino-ready") return;
      clearTimeout(timer);
      resolve({ child, url: `http://127.0.0.1:${message.port}` });
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`kino server exited (${code}).\n${errors}`)); });
  });
}

// One-shot briefs only (prompt version 2): the direction guide would otherwise have the agent
// stop and wait for answers that never come.
const NO_ONE_ANSWERS = "No one will answer questions during this run: make any missing call yourself.";

function prompt(brief, exportDirectory, media = []) {
  const brand = brands[brief.brand];
  if (brief.kit) return [
    `Make this video with the kino tools.`,
    ``,
    `Brief: ${brief.brief}`,
    `Format: ${brief.format} pixels, ${brief.fps} fps, ${brief.duration} seconds.`,
    `The project "${brief.id}" is ready and open. Its brand kit "${brief.brand}" holds ${brand.name}'s colors, fonts and logo. Make the video in that project.`,
    `When the video is finished, export it as an MP4 into ${exportDirectory}.`,
    NO_ONE_ANSWERS,
    `Finish with one line: DONE.`,
  ].join("\n");
  return [
    `Make this video with the kino tools.`,
    ``,
    `Brief: ${brief.brief}`,
    `Format: ${brief.format} pixels, ${brief.fps} fps, ${brief.duration} seconds.`,
    `Brand "${brand.name}": colors ${Object.entries(brand.colors).map(([role, hex]) => `${role} ${hex}`).join(", ")}; display font ${brand.fonts.display}, body font ${brand.fonts.body}.`,
    ...(media.length ? [`Files: ${media.map((file) => `${file.name} at ${file.path}`).join(", ")}.`] : []),
    ``,
    `Create one new project named "${brief.id}". When the video is finished, export it as an MP4 into ${exportDirectory}.`,
    NO_ONE_ANSWERS,
    `Finish with one line: DONE.`,
  ].join("\n");
}

// A direction brief's first message is only the person's request; `{name}` becomes that
// media file's path.
function directionRequest(brief, media = []) {
  return brief.request.replace(/\{([^}]+)\}/g, (whole, name) => media.find((file) => file.name === name)?.path ?? whole);
}

// One short line for the live view (--watch).
const short = (value, length = 110) => String(typeof value === "string" ? value : JSON.stringify(value) ?? "").replace(/\s+/g, " ").slice(0, length);
function show(watch, kind, text) {
  if (!watch) return;
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`  ${time} ${kind.padEnd(7)} ${text}`);
}

// `env` is the agent's whole environment (isolatedEnv); nothing else from this process leaks in.
// With `onInput(stdin)` the agent's standard input stays open for the caller to write to.
// After `timeoutMs` the agent is asked to stop (SIGINT ends Claude Code's turn cleanly), then made to.
function runProcess(command, args, { cwd, env, onLine, onInput, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [onInput ? "pipe" : "ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timers = timeoutMs ? [setTimeout(() => {
      timedOut = true;
      child.kill("SIGINT");
      timers.push(setTimeout(() => child.kill("SIGTERM"), 10_000), setTimeout(() => child.kill("SIGKILL"), 15_000));
    }, timeoutMs)] : [];
    if (onInput) {
      // Writing after the agent exits is not an error worth stopping for.
      child.stdin.on("error", () => {});
      onInput(child.stdin);
    }
    let buffer = "", stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on("error", reject);
    child.on("close", (code) => {
      for (const timer of timers) clearTimeout(timer);
      if (buffer.trim()) onLine(buffer);
      resolve({ code, stderr, timedOut });
    });
  });
}

// The person's side of a direction run. It sends the request, then one scripted reply
// (pickReply) after each finished turn (a result event), and closes the agent's input when
// the person is done: after a turn that asks nothing, a board brief's turn with kino's board
// ask, or the turn after the playback reply (not on a board brief, where the playback's answer
// asks for the storyboard) or the 10th reply. `played` (the playback was answered) tells
// pickReply that a board brief's next questions are the board's open items. `events` is the
// chat as checkDirection() reads it: an "agent" event holds all of one turn's text, after that
// turn's calls.
function createConversation(brief, request, watch) {
  const conversation = { events: [{ type: "person", text: request }], ended: null, cliVersion: null };
  const calls = new Map(); // tool_use id → its call event, so a failed call can be marked
  const used = [];
  let stdin = null, texts = [], replies = 0, lastTurn = false, played = false;
  const say = (text) => {
    show(watch, "person", short(text));
    stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" })}\n`);
  };
  const end = (reason) => { conversation.ended = reason; stdin.end(); };
  conversation.start = (input) => { stdin = input; say(request); };
  conversation.read = (event) => {
    if (event.type === "system" && event.subtype === "init") conversation.cliVersion ??= event.claude_code_version ?? null;
    if (event.type === "assistant") for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
      if (block.type === "tool_use" && !calls.has(block.id)) {
        const call = { type: "call", tool: block.name.replace(/^mcp__kino__/, ""), input: block.input ?? {}, isError: false };
        calls.set(block.id, call);
        conversation.events.push(call);
      }
    }
    if (event.type === "user") for (const block of event.message?.content ?? [])
      if (block.type === "tool_result" && calls.has(block.tool_use_id)) calls.get(block.tool_use_id).isError = Boolean(block.is_error);
    if (event.type !== "result" || conversation.ended) return;
    const text = texts.join("\n\n");
    texts = [];
    if (text) conversation.events.push({ type: "agent", text });
    if (lastTurn) return end(replies >= REPLY_LIMIT ? `${REPLY_LIMIT} replies` : "playback answered");
    const reply = pickReply(brief, text, { used, count: replies, played });
    if (!reply) return end(brief.board && isBoardAsk(text) ? "board asked" : "the agent asked nothing");
    conversation.events.push({ type: "person", text: reply.text });
    if (reply.index != null) used.push(reply.index);
    replies += 1;
    played ||= reply.kind === "playback";
    lastTurn = (reply.kind === "playback" && !brief.board) || replies >= REPLY_LIMIT;
    say(reply.text);
  };
  return conversation;
}

// With streamed input, Claude Code ends each message with its own result event: its usage and
// duration_ms cover that message only, while total_cost_usd is the session's total so far
// (checked with claude 2.1.306). One result for the whole run: the usage added up, the last cost.
function combineResults(results) {
  if (results.length <= 1) return results[0] ?? null;
  const sum = (read) => results.reduce((total, result) => total + (read(result.usage ?? {}) ?? 0), 0);
  return {
    ...results.at(-1),
    usage: {
      input_tokens: sum((usage) => usage.input_tokens),
      cache_creation_input_tokens: sum((usage) => usage.cache_creation_input_tokens),
      cache_read_input_tokens: sum((usage) => usage.cache_read_input_tokens),
      output_tokens: sum((usage) => usage.output_tokens),
      output_tokens_details: { thinking_tokens: sum((usage) => usage.output_tokens_details?.thinking_tokens) },
    },
    duration_ms: results.reduce((total, result) => total + (result.duration_ms ?? 0), 0),
  };
}

// Claude Code: stream-json events. Usage is per assistant message; a message can arrive in
// several events with the same id, so each id is counted once. A direction brief is a
// conversation: the request and the person's replies go in on stdin (createConversation).
async function runClaude({ brief, model, maxTurns, runDirectory, workDirectory, env, mcpConfigPath, exportDirectory, watch, media }) {
  const conversation = brief.direction ? createConversation(brief, directionRequest(brief, media), watch) : null;
  const args = [
    "-p", ...(conversation ? ["--input-format", "stream-json"] : [prompt(brief, exportDirectory, media)]),
    "--mcp-config", mcpConfigPath, "--strict-mcp-config",
    // Only the Skill tool besides kino's (skills need slash commands on).
    "--tools", "Skill", "--allowedTools", "mcp__kino,Skill",
    "--setting-sources", "project", "--no-session-persistence",
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(maxTurns),
    ...(model ? ["--model", model] : []),
  ];
  const seen = new Map();
  const calls = [];
  const results = [];
  let usedModel = null, skillLoaded = false;
  const events = [];
  const { code, stderr, timedOut } = await runProcess("claude", args, {
    cwd: workDirectory,
    env,
    ...(conversation ? { onInput: conversation.start, timeoutMs: brief.board ? BOARD_TIME_LIMIT_MS : DIRECTION_TIME_LIMIT_MS } : {}),
    onLine(line) {
      events.push(line);
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "system" && event.subtype === "init") usedModel = event.model;
      if (event.type === "assistant" && event.message) {
        const message = event.message;
        if (message.usage) seen.set(message.id, message.usage);
        for (const block of message.content ?? []) if (block.type === "text") show(watch, "says", short(block.text));
        for (const block of message.content ?? []) if (block.type === "tool_use") {
          calls.push(block.name.replace(/^mcp__kino__/, ""));
          show(watch, "call", `${block.name.replace(/^mcp__kino__/, "")} ${short(block.input, 100)}`);
          if (block.name === "Skill" && /kino/.test(JSON.stringify(block.input ?? {}))) skillLoaded = true;
        }
      }
      if (event.type === "user" && watch) for (const block of event.message?.content ?? []) if (block.type === "tool_result") {
        const text = Array.isArray(block.content) ? block.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") : block.content;
        const images = Array.isArray(block.content) ? block.content.filter((part) => part.type === "image").length : 0;
        show(watch, block.is_error ? "ERROR" : "answer", `${short(text)}${images ? ` [${images} image${images === 1 ? "" : "s"}]` : ""}`);
      }
      if (event.type === "result") results.push(event);
      conversation?.read(event);
    },
  });
  await writeFile(path.join(runDirectory, "agent-events.jsonl"), `${events.join("\n")}\n`);
  const report = { exitCode: code, error: code === 0 ? null : stderr.slice(-2000), model: usedModel, calls, skillLoaded,
    ...claudeTokens([...seen.values()], combineResults(results)) };
  if (!conversation) return report;
  // A direction run has no DONE line: it finished when the person ended the conversation.
  const ended = timedOut ? "time limit" : conversation.ended ?? "the agent exited";
  return { ...report, finished: code === 0 && Boolean(conversation.ended) && !timedOut, ended,
    conversation: { events: conversation.events, cliVersion: conversation.cliVersion } };
}

// Token totals for one Claude run. The context sizes come from each turn's input; the run
// totals come from the final result event, because streamed assistant events repeat a
// message's usage before its output is complete.
export function claudeTokens(turns, final) {
  const contextOf = (usage) => (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const last = turns.at(-1);
  const total = final?.usage;
  return {
    turns: turns.length,
    startContextTokens: turns[0] ? contextOf(turns[0]) : null,
    finalContextTokens: last ? contextOf(last) + (last.output_tokens ?? 0) : null,
    peakContextTokens: turns.reduce((peak, usage) => Math.max(peak, contextOf(usage) + (usage.output_tokens ?? 0)), 0),
    processedInputTokens: total ? contextOf(total) : turns.reduce((sum, usage) => sum + contextOf(usage), 0),
    outputTokens: total?.output_tokens ?? turns.reduce((sum, usage) => sum + (usage.output_tokens ?? 0), 0),
    thinkingTokens: total?.output_tokens_details?.thinking_tokens ?? null,
    costUsd: final?.total_cost_usd ?? null,
    durationMs: final?.duration_ms ?? null,
    finished: final ? !final.is_error && /DONE/.test(final.result ?? "") : false,
    reply: final?.result?.slice(-500) ?? null,
  };
}

// Recomputes the Claude token numbers of a finished run from its saved agent-events.jsonl.
export async function rescoreClaudeRun(runDirectory) {
  const lines = (await readFile(path.join(runDirectory, "agent-events.jsonl"), "utf8")).trim().split("\n");
  const seen = new Map();
  const results = [];
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "assistant" && event.message?.usage) seen.set(event.message.id, event.message.usage);
    if (event.type === "result") results.push(event);
  }
  return claudeTokens([...seen.values()], combineResults(results));
}

// Token totals for one Codex run from its `codex exec --json` events. turn.completed's
// usage is a running total for the session, so only the LAST one counts (adding them up
// counted early tokens again). All of its fields are kept; dollars come from
// evals/prices.json (null when the model has no confirmed price).
export function codexTokens(events, model, prices = loadPrices()) {
  const usage = codexUsage(events, { model });
  const price = priceUsage(usage, prices);
  const raw = usage.rawUsage ?? {};
  return {
    turns: usage.turnsCompleted,
    processedInputTokens: raw.input_tokens ?? 0, // includes cached and cache-write tokens
    cachedInputTokens: raw.cached_input_tokens ?? 0,
    cacheWriteInputTokens: raw.cache_write_input_tokens ?? 0,
    freshInputTokens: usage.totals.fresh,
    outputTokens: raw.output_tokens ?? 0, // includes reasoning tokens
    reasoningTokens: raw.reasoning_output_tokens ?? 0,
    totalTokens: usage.totals.total,
    usage: usage.rawUsage, // the last turn.completed usage, every field as Codex sent it
    costUsd: price.dollars,
    costApproximate: price.approximate,
  };
}

// Codex: `codex exec --json` events. Token usage arrives on turn.completed.
async function runCodex({ brief, model, runDirectory, workDirectory, env, mcpServer, exportDirectory, watch, media }) {
  const toml = (value) => JSON.stringify(value);
  const envToml = `{${Object.entries(mcpServer.env).map(([key, value]) => `${key}=${toml(value)}`).join(",")}}`;
  const args = [
    "exec", "--json", "--skip-git-repo-check", "-C", workDirectory,
    "-c", `mcp_servers.kino.command=${toml(mcpServer.command)}`,
    "-c", `mcp_servers.kino.args=${toml(mcpServer.args)}`,
    "-c", `mcp_servers.kino.env=${envToml}`,
    // codex exec cannot ask, so kino's tools are pre-approved for this run only.
    "-c", `mcp_servers.kino.default_tools_approval_mode="approve"`,
    "-c", `approval_policy="never"`,
    "--sandbox", "read-only",
    ...(model ? ["-m", model] : []),
    prompt(brief, exportDirectory, media),
  ];
  const calls = [];
  let lastMessage = "", skillLoaded = false;
  const events = [];
  const started = Date.now();
  const { code, stderr } = await runProcess("codex", args, {
    cwd: workDirectory,
    env,
    onLine(line) {
      events.push(line);
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const item = event.item;
      if (event.type === "item.completed" && item?.type === "mcp_tool_call") {
        calls.push(item.tool);
        show(watch, "call", `${item.tool} ${short(item.arguments, 100)}`);
        const answer = item.error?.message ?? (item.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(" ");
        show(watch, item.error || item.result?.isError ? "ERROR" : "answer", short(answer));
      }
      if (event.type === "item.completed" && item?.type === "agent_message") show(watch, "says", short(item.text));
      // Codex reads a skill's SKILL.md with its shell when it decides to use the skill.
      if (event.type === "item.completed" && item?.type === "command_execution") {
        calls.push("shell");
        show(watch, "shell", short(item.command));
        if (/SKILL\.md/.test(item.command ?? "")) skillLoaded = true;
      }
      if (event.type === "item.completed" && item?.type === "agent_message") lastMessage = item.text ?? "";
    },
  });
  await writeFile(path.join(runDirectory, "agent-events.jsonl"), `${events.join("\n")}\n`);
  return {
    exitCode: code,
    error: code === 0 ? null : stderr.slice(-2000),
    model,
    calls,
    skillLoaded,
    finalContextTokens: null,
    peakContextTokens: null,
    ...codexTokens(parseEvents(events.join("\n")), model),
    durationMs: Date.now() - started,
    finished: /DONE/.test(lastMessage),
    reply: lastMessage.slice(-500),
  };
}

async function api(url, route, options = {}) {
  const response = await fetch(`${url}${route}`, options);
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response;
}

// One call to kino's agent service, as the MCP tools make it: { text, data, isError }.
async function agentCall(url, verb, input) {
  return (await api(url, `/api/agent/${verb}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  })).json();
}

// A brand-kit brief starts from the person's own setup: the project, open, marked with the
// brief's video type (so its checks run) and holding the brand kit (colors, fonts, the brand
// name as a text logo), made through the same agent API.
async function prepareKit(url, brief) {
  const brand = brands[brief.brand];
  const [width, height] = brief.format.split("x").map(Number);
  const call = async (verb, input) => {
    const reply = await agentCall(url, verb, input);
    if (reply.isError) throw new Error(`Could not prepare ${brief.id}: ${reply.text}`);
  };
  await call("project", { action: "create", id: brief.id, name: brief.id, width, height, duration: brief.duration, background: brand.colors.bg });
  await call("edit", { project: brief.id, ops: [{ op: "update_project", properties: { videoType: brief.type } }, {
    op: "set_brand", name: brief.brand, colors: brand.colors,
    fonts: [{ family: brand.fonts.display }, { family: brand.fonts.body }], logos: [{ text: brand.name }],
  }] });
}

// The transcript of a direction run (evals/direction.mjs) with `saved`: the brief kino holds
// at the end, read with notes {action:"brief"} on the project the agent made (the one its
// last brief save named, else the newest).
async function directionTranscript({ url, brief, agent }) {
  const { events, cliVersion } = agent.conversation;
  const named = events.filter((event) => event.type === "call" && event.tool === "notes" && !event.isError && event.input?.action === "brief" && event.input.project).at(-1);
  const { projects } = await (await api(url, "/api/projects")).json();
  const project = named?.input.project ?? [...projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.id ?? null;
  const read = project ? await agentCall(url, "notes", { project, action: "brief" }) : null;
  return {
    version: 1, brief: brief.id, source: `claude ${cliVersion ?? "(version unknown)"} ${agent.model ?? "(model unknown)"}`,
    project, events,
    saved: read && !read.isError ? read.data : null,
    ...(read?.isError ? { savedError: read.text } : {}),
  };
}

// What the agent made: project size, the exported file, and review stills.
async function inspectOutcome({ url, brief, runDirectory, exportDirectory }) {
  const { projects } = await (await api(url, "/api/projects")).json();
  const summary = projects.find((project) => project.name === brief.id) ?? projects[0];
  if (!summary) return { project: null };
  const record = await (await api(url, `/api/projects/${encodeURIComponent(summary.id)}`)).json();
  const document = record.document;
  const scenes = document.scenes.filter((scene) => !scene.isComponent);
  // The newest video is the agent's final export (earlier ones were drafts or retries).
  const names = existsSync(exportDirectory) ? (await readdir(exportDirectory)).filter((name) => name.endsWith(".mp4")) : [];
  const exported = (await Promise.all(names.map(async (name) => ({ name, time: (await stat(path.join(exportDirectory, name))).mtimeMs }))))
    .sort((a, b) => b.time - a.time).map((entry) => entry.name);
  const video = exported[0] ? await probeMedia(path.join(exportDirectory, exported[0])).catch((error) => ({ error: error.message })) : null;
  const stills = [];
  await mkdir(path.join(runDirectory, "stills"), { recursive: true });
  for (const [sceneIndex, scene] of scenes.entries()) {
    for (const fraction of [0.1, 0.35, 0.6, 0.9]) {
      const time = Math.round(scene.duration * fraction * 100) / 100;
      const response = await api(url, "/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document, sceneId: scene.id, options: { format: "png", time, width: 480 } }),
      }).catch(() => null);
      if (!response) continue;
      const file = path.join(runDirectory, "stills", `s${sceneIndex + 1}@${time}.png`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      stills.push(path.relative(runDirectory, file));
    }
  }
  // The same check the final render uses (pixels on): counts that are not waived, by rule.
  const check = await api(url, "/api/agent/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: document.id }),
  }).then((response) => response.json()).then(({ data }) => ({ errors: data.errors, warnings: data.warnings, waived: data.waived, waivedFindings: data.waivedFindings, byRule: data.byRule }))
    .catch((error) => ({ error: error.message }));
  return {
    check,
    project: {
      id: document.id,
      name: document.name,
      revision: record.revision,
      scenes: scenes.length,
      formats: [...new Set(scenes.map((scene) => `${scene.width}x${scene.height}`))],
      seconds: Math.round(scenes.reduce((sum, scene) => sum + scene.duration, 0) * 100) / 100,
      layers: scenes.reduce((sum, scene) => sum + scene.layers.length, 0),
      animations: scenes.reduce((sum, scene) => sum + scene.layers.reduce((count, layer) => count + (layer.animations?.length ?? 0), 0), 0),
    },
    export: exported[0] ? { file: exported[0], duration: video?.duration ?? null, width: video?.width ?? null, height: video?.height ?? null, hasAudio: video?.hasAudio ?? null, error: video?.error ?? null } : null,
    features: requiredFeatures(brief, document, video),
    stills,
  };
}

function meterTotals(lines) {
  const byTool = {};
  let outputTokens = 0, inputTokens = 0, largest = null;
  for (const line of lines) {
    const row = (byTool[line.tool] ??= { calls: 0, outputTokens: 0, errors: 0 });
    row.calls += 1;
    row.outputTokens += line.outputTokens;
    row.errors += line.isError ? 1 : 0;
    outputTokens += line.outputTokens;
    inputTokens += line.inputTokens;
    if (!largest || line.outputTokens > largest.outputTokens) largest = { tool: line.tool, outputTokens: line.outputTokens };
  }
  return { calls: lines.length, toolOutputTokens: outputTokens, toolInputTokens: inputTokens, largestAnswer: largest, byTool };
}

// The brief's files for one run: made with FFmpeg (so no large binaries live in the repository)
// or copied from evals/assets. [{name, path}]
async function prepareMedia(brief, runDirectory) {
  if (!brief.media?.length) return [];
  const folder = path.join(runDirectory, "media");
  await mkdir(folder, { recursive: true });
  const files = [];
  for (const item of brief.media) {
    const target = path.join(folder, item.name);
    if (item.copy) await cp(path.join(root, item.copy), target);
    else {
      const made = spawnSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...item.ffmpeg, target], { encoding: "utf8" });
      if (made.status !== 0) throw new Error(`Could not make ${item.name}: ${made.stderr || made.error?.message}`);
    }
    files.push({ name: item.name, path: target });
  }
  return files;
}

// Whether the video has each feature the brief requires, read from the saved project and the
// exported file: audio (a sound track in the export), captions (caption text layers), beats
// (beat cues from detect_beats).
function requiredFeatures(brief, document, video) {
  const layers = document.scenes.flatMap((scene) => scene.layers);
  const found = {
    audio: Boolean(video?.hasAudio),
    captions: layers.filter((layer) => layer.type === "text" && layer.role === "caption").length,
    beats: (document.cues ?? []).filter((cue) => cue.kind === "beat").length,
  };
  return Object.fromEntries((brief.requires ?? []).map((name) => [name, { found: found[name], ok: Boolean(found[name]) }]));
}

async function runOne({ brief, index, options, batchDirectory }) {
  const runDirectory = path.join(batchDirectory, `${brief.id}-${options.agent}-${index + 1}`);
  const dataDirectory = path.join(runDirectory, "data");
  const exportDirectory = path.join(runDirectory, "exports");
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(exportDirectory, { recursive: true });
  const meterFile = path.join(runDirectory, "meter.jsonl");
  // The agent's own temporary folders (work, HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, TMPDIR) and
  // its environment, built from nothing.
  const dirs = await makeTrialDirs({ label: `eval-${brief.id}` });
  const env = isolatedEnv({ agent: options.agent, dirs });
  const workDirectory = await workFolder(dirs.workDir, options.agent);
  const media = await prepareMedia(brief, runDirectory);
  await prepareSettings(dataDirectory, brief);
  const { child, url } = await startServer(dataDirectory);
  try {
    if (brief.kit) await prepareKit(url, brief);
    const mcpServer = {
      command: process.execPath,
      args: [path.join(root, "bin/kino.mjs"), "mcp"],
      env: {
        MOTION_API_URL: url, KINO_METER_FILE: meterFile,
      },
    };
    const mcpConfigPath = path.join(runDirectory, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { kino: mcpServer } }, null, 2));
    const started = Date.now();
    const agent = options.agent === "claude"
      ? await runClaude({ brief, model: options.model, maxTurns: options.maxTurns, runDirectory, workDirectory, env, mcpConfigPath, exportDirectory, watch: options.watch, media })
      : await runCodex({ brief, model: options.model, runDirectory, workDirectory, env, mcpServer, exportDirectory, watch: options.watch, media });
    const meter = existsSync(meterFile)
      ? (await readFile(meterFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const meterSummary = meterTotals(meter);
    const editCalls = agent.calls.filter((name) => name === "edit").length;
    const kinoTokens = await kinoAttributable({ meter: meterSummary, skillLoaded: agent.skillLoaded });
    // A direction run is scored on its transcript only: no export or stills.
    if (brief.direction) {
      const transcript = await directionTranscript({ url, brief, agent });
      await writeFile(path.join(runDirectory, "transcript.json"), JSON.stringify(transcript, null, 2));
      const { conversation, ...agentReport } = agent;
      const direction = checkDirection(transcript, brief);
      // A board brief is scored on the brief's rules and on the storyboard's.
      const board = brief.board ? checkBoard(transcript, brief) : null;
      const result = {
        brief: brief.id, type: brief.type, agent: options.agent, run: index + 1,
        wallMs: Date.now() - started,
        agentReport, meter: meterSummary, editCalls, kinoTokens,
        project: transcript.project, replies: transcript.saved?.replies ?? null,
        direction, ...(board ? { board } : {}), passed: direction.passed && (board?.passed ?? true),
      };
      await writeFile(path.join(runDirectory, "result.json"), JSON.stringify(result, null, 2));
      return result;
    }
    const outcome = await inspectOutcome({ url, brief, runDirectory, exportDirectory });
    const result = {
      brief: brief.id, type: brief.type, agent: options.agent, run: index + 1,
      prompt: PROMPT_VERSION,
      wallMs: Date.now() - started,
      agentReport: agent,
      meter: meterSummary,
      editCalls,
      kinoTokens,
      ...outcome,
    };
    // The A2 target (other briefs): at most 20,000 kino tokens and 6 edits, finished, with the whole video
    // exported (its length within half a second of the brief's).
    const fullLength = outcome.export?.duration != null && Math.abs(outcome.export.duration - brief.duration) <= 0.5;
    result.passed = brief.kit ? kitPassed(brief, result) : Boolean(agent.finished && fullLength && kinoTokens.total <= 20_000 && editCalls <= 6);
    // The quality gates: finished, the export at the brief's full size and length (only a final
    // render has both), 0 check errors at the end, and every required feature present.
    const [width, height] = brief.format.split("x").map(Number);
    const fullSize = outcome.export?.width === width && outcome.export?.height === height;
    const features = Object.values(outcome.features ?? {});
    result.gatesPassed = Boolean(agent.finished && fullLength && fullSize && outcome.check?.errors === 0 && features.every((feature) => feature.ok));
    await writeFile(path.join(runDirectory, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    child.kill("SIGTERM");
    await rm(dirs.trialDir, { recursive: true, force: true });
  }
}

// The empty folder the agent works in: its own Git repository (so neither agent reads
// this checkout's instructions) holding only the kino skill where that agent looks for skills.
async function workFolder(folder, agent) {
  spawnSync("git", ["init", "-q"], { cwd: folder });
  await cp(path.join(root, "skills/kino"), path.join(folder, agent === "claude" ? ".claude/skills/kino" : ".agents/skills/kino"), { recursive: true });
  return folder;
}

// Tokens kino is responsible for: its tool list, the skill (when the agent read it), and
// every tool call's input and answer. Estimates (see backend/meter.mjs).
let definitionTokens = null;
async function kinoAttributable({ meter, skillLoaded }) {
  definitionTokens ??= measureToolDefinitions(await listKinoTools()).definitionTokens;
  const skill = skillLoaded
    ? estimateTextTokens(readFileSync(path.join(root, "skills/kino/SKILL.md"), "utf8"))
    : estimateTextTokens(readFileSync(path.join(root, "skills/kino/SKILL.md"), "utf8").match(/^description:.*$/m)?.[0] ?? "");
  const tools = definitionTokens;
  return { tools, skill, calls: meter.toolInputTokens, answers: meter.toolOutputTokens, total: tools + skill + meter.toolInputTokens + meter.toolOutputTokens };
}

// Re-reads the token numbers of saved Claude runs: node evals/run.mjs --rescore .local/evals/<stamp>
async function rescoreBatch(batchDirectory) {
  const summaryPath = path.join(batchDirectory, "summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  for (const result of summary.results) {
    if (result.agent !== "claude") continue;
    const runDirectory = path.join(batchDirectory, `${result.brief}-${result.agent}-${result.run}`);
    const brief = briefs.find((item) => item.id === result.brief);
    // A direction run has no DONE line, so only its token numbers are read again.
    const { finished, reply, ...tokens } = await rescoreClaudeRun(runDirectory);
    Object.assign(result.agentReport, brief?.direction ? tokens : { finished, reply, ...tokens });
    if (brief?.kit) result.passed = kitPassed(brief, result);
    await writeFile(path.join(runDirectory, "result.json"), JSON.stringify(result, null, 2));
  }
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  const rescore = process.argv.indexOf("--rescore");
  if (rescore !== -1) {
    const summary = await rescoreBatch(path.resolve(process.argv[rescore + 1]));
    for (const { brief, agentReport: report } of summary.results)
      console.log(`${brief}: start context ${report.startContextTokens} · final context ${report.finalContextTokens} · ` +
        `processed ${report.processedInputTokens} in / ${report.outputTokens} out (thinking ${report.thinkingTokens})`);
    console.log(`Passed ${summary.results.filter((result) => result.passed).length} of ${summary.results.length}.`);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const direction = options.briefs.filter((id) => briefs.find((brief) => brief.id === id)?.direction);
  // The person's replies go in on Claude Code's stream-json input; the guide is in the skill.
  const unsupported = direction.length && options.agent === "codex" ? CODEX_DIRECTION : null;
  if (unsupported) {
    console.error(`${direction.join(", ")}: ${unsupported}`);
    process.exitCode = 2;
    return;
  }
  const keyName = API_KEY_VARIABLES[options.agent];
  if (!process.env[keyName]) {
    console.error(`Set ${keyName} first: evals log the agent in with an API key only, never with your own ${options.agent} login.`);
    process.exitCode = 2;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // The agent is in the name so two batches started together never share a folder.
  const batchDirectory = options.out ?? path.join(root, ".local/evals", `${stamp}-${options.agent}`);
  await mkdir(batchDirectory, { recursive: true });
  const results = [];
  for (const id of options.briefs) {
    const brief = briefs.find((item) => item.id === id);
    if (!brief) throw new Error(`Unknown brief ${id}.`);
    for (let index = 0; index < options.runs; index += 1) {
      console.log(`▸ ${brief.id} · ${options.agent} · run ${index + 1}/${options.runs}`);
      const result = await runOne({ brief, index, options, batchDirectory });
      results.push(result);
      const report = result.agentReport;
      if (result.direction) {
        const passedChecks = result.direction.checks.filter((check) => check.ok).length;
        console.log(`  ${result.passed ? "PASS" : "fail"} · ${passedChecks} of ${result.direction.checks.length} brief rules · ended: ${report.ended} · ` +
          `kino counted ${result.replies?.count ?? "no"} replies · ${report.calls.length} calls · kino ${result.kinoTokens.total} tokens · ` +
          `processed ${report.processedInputTokens} in / ${report.outputTokens} out · ${report.costUsd != null ? `$${report.costUsd.toFixed(2)} · ` : ""}${Math.round(result.wallMs / 1000)} s`);
        for (const check of result.direction.checks) console.log(`    ${check.ok ? "ok  " : "FAIL"} ${check.id}: ${check.detail}`);
        if (result.board) {
          console.log(`  storyboard: ${result.board.checks.filter((check) => check.ok).length} of ${result.board.checks.length} board rules`);
          for (const check of result.board.checks) console.log(`    ${check.ok ? "ok  " : "FAIL"} ${check.id}: ${check.detail}`);
        }
        continue;
      }
      console.log(`  ${result.passed ? "PASS" : "fail"} · gates ${result.gatesPassed ? "PASS" : "fail"}${Object.keys(result.features ?? {}).length ? ` (${Object.entries(result.features).map(([name, feature]) => `${name} ${feature.found}`).join(", ")})` : ""} · ${report.finished ? "finished" : "NOT finished"} · ${report.calls.length} calls (${result.editCalls} edits) · ` +
        `kino ${result.kinoTokens.total} tokens (tools ${result.kinoTokens.tools}, skill ${result.kinoTokens.skill}${report.skillLoaded ? " read" : ""}, calls ${result.kinoTokens.calls}, answers ${result.kinoTokens.answers}) · ` +
        `final context ${report.finalContextTokens ?? "?"} · processed ${report.processedInputTokens} in / ${report.outputTokens} out · ` +
        `${report.costUsd != null ? `$${report.costUsd.toFixed(2)} · ` : ""}${Math.round(result.wallMs / 1000)} s · ` +
        `export ${result.export ? `${result.export.width}x${result.export.height} ${result.export.duration}s` : "none"} · ` +
        `check ${result.check?.error ? "failed" : `${result.check?.errors ?? "?"} err · ${result.check?.warnings ?? "?"} warn${result.check?.waived ? ` · ${result.check.waived} waived` : ""}`}`);
    }
  }
  await writeFile(path.join(batchDirectory, "summary.json"), JSON.stringify({ options, results }, null, 2));
  // Direction runs make no video, so they have no quality gates.
  const gated = results.filter((result) => !result.direction);
  console.log(`Passed ${results.filter((result) => result.passed).length} of ${results.length}` +
    `${gated.length ? `; quality gates passed ${gated.filter((result) => result.gatesPassed).length} of ${gated.length}` : ""}. Results: ${batchDirectory}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
