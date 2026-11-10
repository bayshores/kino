#!/usr/bin/env node
// Compares two judge packets blind (evals/taste/README.md).
//
//   node evals/taste/judge.mjs <packet folder X> <packet folder Y> [--names x,y] [--samples 3]
//
// Each call shows the two videos as A and B (copies of the sheets only, in a fresh folder, so no
// file name or path tells which is which) to Claude headless (`claude -p`, Read as the only
// tool). Both orders, `samples` calls each, scores are medians. A win counts only when it holds
// in both orders. The verdict is appended to evals/taste/results/judged.jsonl and printed.
// Model: KINO_TASTE_MODEL (default "opus"). Calls side by side: KINO_TASTE_JOBS (default 3).
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { median } from "./lib.mjs";
import { beatFitLine } from "../../backend/measure/beat-fit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORDS = ["storytelling", "directing", "uniqueness", "impressiveness", "quality", "smoothness", "audio_mix"];
const MODEL = process.env.KINO_TASTE_MODEL || "opus";
const JOBS = Number(process.env.KINO_TASTE_JOBS) || 3;
const CALL_TIMEOUT_MS = 15 * 60 * 1000;

/** The facts of one packet as short text for the prompt (no sheet names, no source). */
export function factsText(facts) {
  const lines = [`length ${facts.duration} s, ${facts.size}, rendered at ${facts.sourceFps} fps`];
  const loud = facts.loudness;
  if (loud) {
    lines.push(`loudness (measured, not normalized): integrated ${loud.integrated} LUFS, range ${loud.range} LU, true peak ${loud.truePeak} dBTP`);
    lines.push("loudness every 0.5 s as time: short-term (3 s window) / momentary (0.4 s), LUFS, -70 = silence:");
    for (let i = 0; i < loud.shortTerm.length; i += 10) lines.push("  " + loud.shortTerm.slice(i, i + 10).map(([t, s, m]) => `${t}:${s}/${m}`).join(" "));
  } else lines.push("no sound");
  lines.push(`cuts (time, scene-change score 0-100): ${facts.cuts.map((cut) => `${cut.t}(${cut.score})`).join(" ") || "none detected"}`);
  const motion = facts.motion;
  lines.push(`shots: ${motion.shotLengths.count}, mean ${motion.shotLengths.mean} s, longest ${motion.shotLengths.longest} s`);
  lines.push(`frozen stretches (no pixel change 1 s or more): ${motion.freezes.map(([a, b]) => `${a}-${b}`).join(", ") || "none"}`);
  lines.push(`brightness jumps away from cuts (over 2% a frame): ${motion.brightnessJumpCount}; biggest at ${motion.brightnessJumps.map((jump) => `${jump.t}(${jump.change > 0 ? "+" : ""}${jump.change})`).join(" ")}`);
  const events = facts.events;
  if (events) lines.push(`flashes: ${events.flashes.map((flash) => `${flash.t}-${flash.end}`).join(" ") || "none"}; black: ${events.blacks.map((span) => `${span.t}-${span.end}`).join(" ") || "none"}; holds 0.5 s or more: ${events.holds.map((span) => `${span.t}-${span.end}`).join(" ") || "none"}`);
  if (facts.beats?.bpm) lines.push(`beat grid: ${facts.beats.bpm} bpm from ${facts.beats.first} s, confidence ${facts.beats.confidence}`);
  if (facts.beatFit) lines.push(beatFitLine(facts.beatFit));
  if (facts.sections?.sections?.length) lines.push(`song sections (from the final mix): ${facts.sections.sections.map((part) => `${part.at} ${part.kind}`).join(", ")}`);
  if (facts.transcript) lines.push(`speech heard (word@start s; ~ = unclear):\n${facts.transcript.lines.map((line) => `  ${line}`).join("\n")}`);
  if (facts.voiceOverMusic?.length) {
    lines.push("each speech line's momentary loudness vs the 1.5 s before it (LU over; rough voice-over-music level, null = no gap before):");
    lines.push("  " + facts.voiceOverMusic.map((entry) => `${entry.t}s "${entry.words}" ${entry.line} vs ${entry.before ?? "-"} (${entry.over === null ? "-" : `${entry.over > 0 ? "+" : ""}${entry.over}`})`).join("; "));
  }
  // Notes are error messages; drop any file path in them so no folder name reaches the judge.
  for (const note of facts.notes ?? []) lines.push(`(${String(note).replace(/(?:\/[^\s/:'"()]+){2,}\/?/g, "<file>")})`);
  return lines.join("\n");
}

/** The prompt for one call: videos A and B, their facts and sheet files, the rubric. */
export function judgePrompt(a, b) {
  const sheetList = (side, facts) => [...facts.sheets.overview.map((sheet) => `${side}/${sheet.file} (overview ${sheet.from}-${sheet.to} s)`),
    ...facts.sheets.strips.map((sheet) => `${side}/${sheet.file} (cuts ${sheet.cuts.join(", ")} s)`)].join("\n");
  return `You are judging two short edits (videos A and B) the way their owner would: which one would they post? You cannot play them; you get their frames and measured facts.

Pictures (Read every one before you answer; read several at once):
${sheetList("A", a)}
${sheetList("B", b)}
Overview sheets show 2 frames a second, left to right, each tagged with its time. Strip sheets show 12 frames a second for 0.5 s each side of every cut (yellow tag = first frame after the cut).

Video A facts:
${factsText(a)}

Video B facts:
${factsText(b)}

Both lengths are as made; do not prefer one for its length. Frame rate and softness are draft render settings, not choices: do not judge them. Sound is judged from the numbers: is the voice clear over the music, does loudness build to the important moments, does the song's structure (drops, breaks) land on the story's turns.

Rules: a defect counts only if it would make a viewer stop watching. Safe is not a virtue: an edit that does nothing wrong and nothing memorable loses to one that takes risks and lands most of them.

Before choosing, write for each video:
1. pitch: one line on what this edit is about and its idea;
2. memorable: its 2 most memorable seconds (time and why);
3. generic_moves: the moves that would fit any product (stock transitions, boxed captions, template beats).
Then score each video from -3 to +3 (0 = an ordinary competent edit of this kind, +3 = the best edits people share) on: ${WORDS.join(", ")}. Every score cites times.
Then answer: which would the owner post? "A", "B" or "same".

Answer with only this JSON, no other text. Inside its strings never use a double quote: quote on-screen words with single quotes ('like this').
{"A":{"pitch":"","memorable":[{"t":0,"why":""},{"t":0,"why":""}],"generic_moves":[""],"scores":{${WORDS.map((word) => `"${word}":{"score":0,"times":""}`).join(",")}}},"B":{same shape},"post":"A","why":"one or two sentences"}`;
}

/**
 * Mends the usual slips in a model's JSON: a double quote inside a string (it quoted on-screen
 * words), a raw line break inside a string, a comma before } or ], a } left off the end. A quote
 * ends its string only when what follows fits the JSON there: after a key, a colon; after a value
 * in an object, } or a comma then the next "key":; after a value in an array, ] or a comma then
 * the next value.
 */
export function mendJson(text) {
  const ends = { key: /^\s*:/, object: /^\s*(,?\s*}|,\s*"\w+"\s*:)/, array: /^\s*(,?\s*]|,\s*["{[\d-])/ };
  const stack = [];
  let out = "", string = null, expectKey = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (string) {
      if (char === "\\") { out += char + (text[i + 1] ?? ""); i += 1; continue; }
      if (char === "\n" || char === "\r") { out += char === "\n" ? "\\n" : ""; continue; }
      if (char !== "\"") { out += char; continue; }
      const rest = text.slice(i + 1);
      const closes = !rest.trim() || ends[string].test(rest);
      out += closes ? char : "\\\"";
      if (closes) string = null;
      continue;
    }
    if (char === "\"") string = expectKey ? "key" : stack.at(-1) === "[" ? "array" : "object";
    else if (char === "{" || char === "[") { stack.push(char); expectKey = char === "{"; }
    else if (char === "}" || char === "]") {
      stack.pop();
      if (!stack.length) return out + char; // the answer is closed: ignore any text after it
    }
    else if (char === ":") expectKey = false;
    else if (char === ",") {
      if (/^\s*[}\]]/.test(text.slice(i + 1))) continue;
      expectKey = stack.at(-1) === "{";
    }
    out += char;
  }
  // Close what is still open (a model sometimes drops a } near the end).
  return out + (string ? "\"" : "") + stack.reverse().map((open) => (open === "{" ? "}" : "]")).join("");
}

/**
 * Lifts A, B, post and why to the top when a dropped } nested them inside another object. It takes
 * the shallowest match, so a memorable moment's own "why" deeper down is never taken for the verdict's.
 */
function liftAnswer(answer) {
  const found = (root, key) => {
    for (let level = [root]; level.length; level = level.flatMap((node) => Object.values(node))) {
      level = level.filter((node) => node && typeof node === "object");
      const hit = level.find((node) => key in node);
      if (hit) return hit[key];
    }
    return undefined;
  };
  for (const key of ["A", "B", "post", "why"]) if (!(key in answer)) { const value = found(answer, key); if (value !== undefined) answer[key] = value; }
  return answer;
}

/**
 * The answer object in a model's reply (the text between its first { and last }), mended when it
 * does not parse as it is. The mend reads on to the end of the reply, since a dropped last } puts
 * post and why after the last }. Throws when there is no JSON or it has no post of "A", "B" or "same".
 */
export function answerJson(text) {
  const from = text.indexOf("{"), to = text.lastIndexOf("}");
  if (from < 0 || to <= from) throw new Error(`no JSON in the answer: ${text.slice(0, 200)}`);
  const body = text.slice(from, to + 1);
  let answer;
  try { answer = JSON.parse(body); } catch (error) {
    try { answer = liftAnswer(JSON.parse(mendJson(text.slice(from).replace(/\s*```\s*$/, "")))); } catch {
      // Keep the text around the spot the parser stopped at, so the log shows the slip.
      const at = Number(/position (\d+)/.exec(error.message)?.[1]) || 0;
      throw new Error(`unparsable answer (${error.message}): ...${body.slice(Math.max(0, at - 120), at + 60)}...`);
    }
  }
  if (!["A", "B", "same"].includes(answer?.post)) throw new Error(`answer has no post of A, B or same: ${String(answer?.post).slice(0, 40)}`);
  return answer;
}

/** Calls each order needs before a verdict names a winner. */
export const MIN_SAMPLES = 2;

/**
 * Combines the calls into a verdict between x and y. calls: [{order: "xy"|"yx", answer}] where in
 * order "xy" A is x. Returns {winner: "x"|"y"|"same"|"too_few", orders: {xy, yx}, used: {xy, yx},
 * scores: {x: {word: median}, y}, posts}. winner is "too_few" when an order has fewer than
 * MIN_SAMPLES answers: one or two calls are too noisy to name a winner.
 */
export function combine(calls) {
  const side = (order, letter) => ((order === "xy") === (letter === "A") ? "x" : "y");
  const posts = { xy: [], yx: [] };
  const scores = { x: Object.fromEntries(WORDS.map((word) => [word, []])), y: Object.fromEntries(WORDS.map((word) => [word, []])) };
  for (const { order, answer } of calls) {
    posts[order].push(answer.post === "A" || answer.post === "B" ? side(order, answer.post) : "same");
    for (const letter of ["A", "B"]) for (const word of WORDS) {
      const value = Number(answer[letter]?.scores?.[word]?.score);
      if (Number.isFinite(value)) scores[side(order, letter)][word].push(value);
    }
  }
  const majority = (list) => {
    const x = list.filter((pick) => pick === "x").length, y = list.filter((pick) => pick === "y").length;
    return x > y ? "x" : y > x ? "y" : "same";
  };
  const orders = { xy: majority(posts.xy), yx: majority(posts.yx) };
  const used = { xy: posts.xy.length, yx: posts.yx.length };
  const winner = Math.min(used.xy, used.yx) < MIN_SAMPLES ? "too_few" : orders.xy === orders.yx ? orders.xy : "same";
  const medians = (side) => Object.fromEntries(WORDS.map((word) => [word, median(scores[side][word])]));
  return { winner, orders, used, posts, scores: { x: medians("x"), y: medians("y") } };
}

/** One `claude -p` call. Every failure names its reason: timeout, exit code, CLI error, or unparsable answer. */
function callClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--restricted", "--tools", "Read", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--model", MODEL],
      { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, CALL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`timeout after ${CALL_TIMEOUT_MS / 60000} min`));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${(err || out).slice(-400)}`));
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) throw new Error(`claude error (${envelope.subtype ?? "unknown"}): ${String(envelope.result ?? "").slice(0, 300)}`);
        let answer;
        try { answer = answerJson(String(envelope.result ?? "")); } catch (error) { error.text = String(envelope.result ?? ""); throw error; }
        resolve({ answer, cost: envelope.total_cost_usd ?? null, turns: envelope.num_turns ?? null, models: Object.keys(envelope.modelUsage ?? {}) });
      } catch (error) { reject(error); }
    });
    child.stdin.end(prompt);
  });
}

/** Copies the sheets of packets into a fresh folder as A/ and B/. */
async function blindFolder(first, second) {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-taste-judge-"));
  for (const [side, packet] of [["A", first], ["B", second]]) {
    await mkdir(path.join(folder, side));
    for (const sheet of [...packet.facts.sheets.overview, ...packet.facts.sheets.strips]) await copyFile(path.join(packet.folder, sheet.file), path.join(folder, side, sheet.file));
  }
  return folder;
}

async function readPacket(folder) {
  const facts = JSON.parse(await readFile(path.join(folder, "facts.json"), "utf8"));
  const source = JSON.parse(await readFile(path.join(folder, "source.json"), "utf8"));
  return { folder, facts, id: source.id };
}

export async function judgePair(folderX, folderY, { samples = 3, names = null } = {}) {
  const x = await readPacket(folderX), y = await readPacket(folderY);
  const jobs = [];
  for (let n = 0; n < samples; n += 1) for (const order of ["xy", "yx"]) jobs.push(order);
  const calls = [], failures = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const order = jobs[next++];
      const [first, second] = order === "xy" ? [x, y] : [y, x];
      const folder = await blindFolder(first, second);
      try {
        // A failed call is tried once more; the first reason is logged and kept in the record.
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const result = await callClaude(judgePrompt(first.facts, second.facts), folder);
            calls.push({ order, ...result });
            process.stderr.write(`  ${order} call done: post ${result.answer.post}${attempt > 1 ? " (retry)" : ""}\n`);
            break;
          } catch (error) {
            failures.push({ order, attempt, error: error.message.slice(0, 400) });
            // Keep an unparsable answer whole (results/failed.jsonl, not committed) to study the slip.
            if (error.text) {
              await mkdir(path.join(HERE, "results"), { recursive: true });
              await appendFile(path.join(HERE, "results", "failed.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), order, error: error.message.slice(0, 200), text: error.text })}\n`);
            }
            process.stderr.write(`  ${order} call failed (try ${attempt} of 2): ${error.message.slice(0, 300)}\n`);
          }
        }
      } finally { await rm(folder, { recursive: true, force: true }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, jobs.length) }, worker));
  const verdict = combine(calls);
  const label = (side) => (side === "x" ? x.id : side === "y" ? y.id : "same");
  const record = {
    at: new Date().toISOString(), model: MODEL, models: [...new Set(calls.flatMap((call) => call.models ?? []))], a: x.id, b: y.id, names: names ? { [x.id]: names[0], [y.id]: names[1] } : null,
    winner: { x: "a", y: "b" }[verdict.winner] ?? verdict.winner, orders: verdict.orders, used: verdict.used, posts: verdict.posts,
    scores: { a: verdict.scores.x, b: verdict.scores.y }, failures,
    notes: calls.map((call) => {
      const own = (letter) => ((call.order === "xy") === (letter === "A") ? "a" : "b");
      return { order: call.order, post: call.answer.post === "A" || call.answer.post === "B" ? own(call.answer.post) : "same", why: call.answer.why,
        a: pick(call.answer[call.order === "xy" ? "A" : "B"]), b: pick(call.answer[call.order === "xy" ? "B" : "A"]) };
    }),
    cost: calls.reduce((sum, call) => sum + (call.cost ?? 0), 0),
  };
  return { record, text: report(record, label) };
}

const pick = (video) => (video ? { pitch: video.pitch, memorable: video.memorable, generic_moves: video.generic_moves } : null);

/** A short text report of a verdict. */
export function report(record) {
  const name = (id) => record.names?.[id] ?? id;
  const lines = [`${name(record.a)} (a) vs ${name(record.b)} (b), model ${record.model}`,
    `winner: ${{ same: "none (no win held in both orders)", too_few: `too few samples (fewer than ${MIN_SAMPLES} answers in an order)` }[record.winner] ?? name(record[record.winner])}; order a-first ${record.orders.xy === "x" ? "a" : record.orders.xy === "y" ? "b" : "same"}, b-first ${record.orders.yx === "x" ? "a" : record.orders.yx === "y" ? "b" : "same"}`,
    `median scores (a / b):`];
  for (const word of WORDS) lines.push(`  ${word.padEnd(15)} ${record.scores.a[word] ?? "-"} / ${record.scores.b[word] ?? "-"}`);
  const first = record.notes[0];
  if (first) {
    const shown = first.order === "xy" ? "a was shown as A" : "a was shown as B";
    lines.push(`pitch a: ${first.a?.pitch ?? "-"}`, `pitch b: ${first.b?.pitch ?? "-"}`, `why (first call, ${shown}): ${first.why ?? "-"}`);
  }
  if (record.used) lines.push(`samples used: a-first ${record.used.xy}, b-first ${record.used.yx}`);
  if (record.failures.length) lines.push(`failed tries (each retried once): ${record.failures.length} (${[...new Set(record.failures.map((failure) => failure.error.split(/[:(]/)[0].trim()))].join(", ")})`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const folders = args.filter((arg, i) => !arg.startsWith("--") && !["--names", "--samples"].includes(args[i - 1]));
  if (folders.length !== 2) {
    console.error("usage: node evals/taste/judge.mjs <packet X> <packet Y> [--names x,y] [--samples 3]");
    process.exit(2);
  }
  const { record, text } = await judgePair(folders[0], folders[1], { samples: Number(value("--samples")) || 3, names: value("--names")?.split(",") ?? null });
  await mkdir(path.join(HERE, "results"), { recursive: true });
  await appendFile(path.join(HERE, "results", "judged.jsonl"), `${JSON.stringify(record)}\n`);
  console.log(text);
}
