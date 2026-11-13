#!/usr/bin/env node
// A hand-run report on how agents used kino, read from saved Claude Code transcripts (JSON lines).
// Not part of `npm test`. Usage:
//   node scripts/harness-report.mjs [--ops] <transcript.jsonl> [more.jsonl ...]
//   node scripts/harness-report.mjs .local/taste/runs/*/transcript.jsonl
// Per run, then in total: kino calls by tool; the share of kino commands piped through head, tail
// or grep; the share of kino answers that reached the agent with a `next:` line; the follow rate
// (the agent's next kino call has the same tool and the same action, topic or mode as the printed
// next); the number of waive_check ops; the distinct edit ops used; the largest answer in characters.
// The agent drives kino through Bash (`kino edit ...`) or through the MCP tools (mcp__kino__edit).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLS = ["status", "edit", "check", "look", "render", "project", "library", "inspect", "history", "notes"];
const TOOL_WORDS = TOOLS.join("|");
// `kino edit ...` anywhere in a shell command (after a start, a separator, a bracket or a space).
const KINO_COMMAND = new RegExp(`(?:^|[;&|(\\s])kino\\s+(${TOOL_WORDS})\\b([^;&|\\n]*)`, "g");

/** The action, topic or mode in a call's words (`mode=review`, `"mode":"review"`, `mode:"review"`), or "". */
export function keyOf(words) {
  for (const name of ["action", "topic", "mode"]) {
    const found = String(words ?? "").match(new RegExp(`["']?${name}["']?\\s*[=:]\\s*["']?([A-Za-z_]+)`));
    if (found) return found[1];
  }
  return "";
}

/** How a shell command cuts its output: "head", "tail", "grep" (first one found after a pipe) or null. */
export function pipeKind(command) {
  return String(command ?? "").match(/\|\s*(head|tail|grep)\b/)?.[1] ?? null;
}

/**
 * The kino calls typed in a shell command, as [{tool, key, piped}], in order. `piped` is how that
 * call's own pipeline cuts its output: only what follows it up to the next `;`, `&&` or new line
 * counts, so `kino status; ls | head` is not piped.
 */
export function kinoCallsIn(command) {
  const text = String(command ?? "");
  return [...text.matchAll(KINO_COMMAND)].map((found) => {
    const rest = text.slice(found.index + found[0].length).split(/;|&&|\n/)[0];
    return { tool: found[1], key: keyOf(found[2]), piped: pipeKind(rest) };
  });
}

/** The op names in an edit written in a command or an MCP input (`"op":"add_layer"`). */
export function opsIn(text) {
  return [...String(text ?? "").matchAll(/["']?\bop["']?\s*[:=]\s*["']([a-z_]+)["']/g)].map((found) => found[1]);
}

/** An answer's text from a tool_result content (a string, or a list of text parts). */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  return "";
}

/**
 * The next call an answer printed, as {tool, key}, or null: its last `next:` line, else the "next"
 * key of a JSON answer (a receipt or a refusal). A next that names no kino tool is {tool: "?"}.
 */
export function nextOf(answer) {
  const text = String(answer ?? "");
  const lines = text.split("\n").filter((line) => line.startsWith("next:"));
  let words = lines.length ? lines.at(-1).slice(5).trim() : null;
  if (words === null) {
    const keyed = [...text.matchAll(/"next"\s*:\s*("(?:[^"\\]|\\.)*")/g)].at(-1);
    if (keyed) { try { words = JSON.parse(keyed[1]); } catch { words = null; } }
  }
  if (words === null) return null;
  const tool = words.match(new RegExp(`^(${TOOL_WORDS})\\b(.*)`, "s"));
  return tool ? { tool: tool[1], key: keyOf(tool[2]) } : { tool: "?", key: "" };
}

/**
 * The kino commands of one transcript, in order, as [{calls, piped, ops, answer}]: `calls` is the
 * kino calls in the command ({tool, key}), `piped` how its output was cut, `ops` the edit ops
 * written in it, `answer` the text that came back (null if none did).
 */
export function commandsFrom(lines) {
  const commands = [];
  const byId = new Map();
  for (const line of lines) {
    let entry;
    try { entry = typeof line === "string" ? JSON.parse(line) : line; } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (entry.type === "assistant" && part?.type === "tool_use") {
        const input = part.input ?? {};
        let command = null;
        if (part.name === "Bash") {
          const calls = kinoCallsIn(input.command);
          if (calls.length) command = { calls, piped: calls.find((call) => call.piped)?.piped ?? null, ops: opsIn(input.command), answer: null };
        } else if (/^mcp__.*kino__/.test(part.name)) {
          const tool = part.name.split("__").at(-1);
          if (TOOLS.includes(tool)) command = { calls: [{ tool, key: String(input.action ?? input.topic ?? input.mode ?? "") }], piped: null, ops: opsIn(JSON.stringify(input.ops ?? [])), answer: null };
        }
        if (command) { commands.push(command); byId.set(part.id, command); }
      } else if (entry.type === "user" && part?.type === "tool_result" && byId.has(part.tool_use_id)) {
        byId.get(part.tool_use_id).answer = textOf(part.content);
      }
    }
  }
  return commands;
}

/** The numbers for a list of commands (see the header). */
export function summarize(commands) {
  const calls = {};
  const ops = {};
  let piped = 0;
  const cut = { head: 0, tail: 0, grep: 0 };
  let answers = 0;
  let withNext = 0;
  let followed = 0;
  let asked = 0;
  let largest = 0;
  let waived = 0;
  let waiting = null;
  for (const command of commands) {
    for (const { tool } of command.calls) calls[tool] = (calls[tool] ?? 0) + 1;
    if (command.piped) { piped += 1; cut[command.piped] += 1; }
    for (const op of command.ops) {
      ops[op] = (ops[op] ?? 0) + 1;
      if (op === "waive_check") waived += 1;
    }
    // The agent's call after a printed next: the same tool and the same action, topic or mode.
    if (waiting) {
      asked += 1;
      if (waiting.tool === command.calls[0].tool && waiting.key === command.calls[0].key) followed += 1;
      waiting = null;
    }
    if (command.answer !== null) {
      answers += 1;
      largest = Math.max(largest, command.answer.length);
      const next = nextOf(command.answer);
      if (next) { withNext += 1; waiting = next; }
    }
  }
  return { commands: commands.length, calls, piped, cut, answers, withNext, followed, asked, waived, ops, largest };
}

/** Add several summaries together (the total line). */
export function addSummaries(list) {
  const total = { commands: 0, calls: {}, piped: 0, cut: { head: 0, tail: 0, grep: 0 }, answers: 0, withNext: 0, followed: 0, asked: 0, waived: 0, ops: {}, largest: 0 };
  for (const one of list) {
    for (const key of ["commands", "piped", "answers", "withNext", "followed", "asked", "waived"]) total[key] += one[key];
    for (const key of ["head", "tail", "grep"]) total.cut[key] += one.cut[key];
    for (const [name, count] of Object.entries(one.calls)) total.calls[name] = (total.calls[name] ?? 0) + count;
    for (const [name, count] of Object.entries(one.ops)) total.ops[name] = (total.ops[name] ?? 0) + count;
    total.largest = Math.max(total.largest, one.largest);
  }
  return total;
}

const percent = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : "n/a");

/** One report line for a summary: `name  kino commands N (edit 4, ...) | piped 40% (head 3, tail 1, grep 2) | ...`. */
export function reportLine(name, s) {
  const byTool = Object.entries(s.calls).sort((a, b) => b[1] - a[1]).map(([tool, count]) => `${tool} ${count}`).join(", ");
  const cut = Object.entries(s.cut).map(([kind, count]) => `${kind} ${count}`).join(", ");
  return `${name}  kino calls ${Object.values(s.calls).reduce((a, b) => a + b, 0)} (${byTool || "none"}) | piped ${percent(s.piped, s.commands)} of ${s.commands} commands (${cut}) | answers with next: ${percent(s.withNext, s.answers)} of ${s.answers} | follow ${percent(s.followed, s.asked)} (${s.followed}/${s.asked}) | waive_check ${s.waived} | distinct ops ${Object.keys(s.ops).length} | largest answer ${s.largest} chars`;
}

/** The distinct ops with counts, most used first, as one line. */
export const opsLine = (s) => Object.entries(s.ops).sort((a, b) => b[1] - a[1]).map(([op, count]) => `${op} ${count}`).join(", ");

/** The whole report for named transcripts [{name, text}]: lines to print. */
export function report(transcripts, { ops = false } = {}) {
  const lines = [];
  const all = [];
  for (const { name, text } of transcripts) {
    const s = summarize(commandsFrom(text.split("\n")));
    all.push(s);
    lines.push(reportLine(name, s));
    if (ops) lines.push(`  ops: ${opsLine(s) || "none"}`);
  }
  const total = addSummaries(all);
  lines.push(reportLine(`TOTAL (${transcripts.length} runs)`, total));
  if (ops) lines.push(`  ops: ${opsLine(total) || "none"}`);
  return lines;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (!files.length) {
    console.error("usage: node scripts/harness-report.mjs [--ops] <transcript.jsonl> [more.jsonl ...]");
    process.exit(2);
  }
  const transcripts = files.map((file) => ({ name: path.basename(path.dirname(path.resolve(file))), text: readFileSync(file, "utf8") }));
  console.log(report(transcripts, { ops: args.includes("--ops") }).join("\n"));
}
