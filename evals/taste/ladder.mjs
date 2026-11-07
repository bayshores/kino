#!/usr/bin/env node
// The taste ladder (evals/taste/README.md): Bradley-Terry ratings over every judged pair in
// evals/taste/results/*.jsonl plus the owner's picks (evals/taste/picks.jsonl, and the desktop app's
// pick box: <data>/taste/picks.jsonl, see picks.md), and how often the
// judge agrees with the owner's held-out picks.
//
//   node evals/taste/ladder.mjs [--owner-weight 3]
//
// Owner picks are the truth: each counts `owner-weight` judge verdicts. Half of them (every other
// pick by time, splitPicks) are judge examples and go into the ratings; the other half are held
// out: they are left out of the ratings and only compared with the judge. Writes a small summary
// to evals/taste/results/ladder.json.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agreement, bradleyTerry, pickWinner, splitPicks } from "./lib.mjs";
import { hashOf } from "./packet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function readLines(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** Judge records as pair results and as verdicts {left, right, pick}; a "too_few" verdict is left out. */
export function fromJudged(records) {
  return records.filter((record) => record.winner !== "too_few").map((record) => ({ a: record.a, b: record.b, winner: record.winner, weight: 1, verdict: { left: record.a, right: record.b, pick: record.winner === "a" ? "left" : record.winner === "b" ? "right" : "same" } }));
}

/** Owner picks {left, right, pick} as pair results with `weight`. */
export function fromPicks(picks, weight) {
  return picks.map((pick) => ({ a: pick.left, b: pick.right, winner: pick.pick === "left" ? "a" : pick.pick === "right" ? "b" : "same", weight }));
}

/**
 * A pick from the app's pick box ({a, b, pick: "a"|"b"|"same"|"neither", mode, words, at}, a and b
 * are video paths) in the ladder's form ({left, right, pick, part}); `idOf` maps a path to its packet
 * id. "neither" (both bad) counts as a tie, marked bothBad so the summary can count it.
 */
export function fromAppPick(line, idOf) {
  const pick = line.pick === "a" ? "left" : line.pick === "b" ? "right" : line.pick === "same" || line.pick === "neither" ? "same" : "skip";
  return { at: line.at, left: idOf(line.a), right: idOf(line.b), pick, part: line.mode === "audio" ? "sound" : "all", words: line.words, blind: true, ...(line.pick === "neither" ? { bothBad: true } : {}) };
}

/** The ladder summary: {ratings, names, judged, ownerPicks, agreement}. A both-bad pick is a tie: half a win each, never decisive. */
export function ladder(records, picks, { ownerWeight = 3 } = {}) {
  const whole = picks.filter((pick) => (pick.part ?? "all") === "all" && pick.pick !== "skip");
  const { examples, heldOut } = splitPicks(whole);
  const judged = fromJudged(records);
  const ratings = bradleyTerry([...judged, ...fromPicks(examples, ownerWeight)]);
  const names = {};
  for (const record of records) Object.assign(names, record.names ?? {});
  for (const pick of picks) Object.assign(names, pick.names ?? {});
  const held = agreement(heldOut, judged.map((entry) => entry.verdict));
  return { ratings, names, judged: records.length, ownerPicks: { all: whole.length, examples: examples.length, heldOut: heldOut.length, decisiveHeldOut: heldOut.filter(pickWinner).length, bothBad: whole.filter((pick) => pick.bothBad).length },
    agreement: held, examplesAgreement: agreement(examples, judged.map((entry) => entry.verdict)), calibrated: held.compared >= 20 && held.matched / held.compared >= 0.8 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const ownerWeight = Number(args[args.indexOf("--owner-weight") + 1]) || 3;
  const folder = path.join(HERE, "results");
  const files = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
  const records = (await Promise.all(files.map((name) => readLines(path.join(folder, name))))).flat();
  const dataDir = process.env.MOTION_DATA_DIR ?? path.join(HERE, "..", "..", ".local", "data");
  const appLines = await readLines(path.join(dataDir, "taste", "picks.jsonl"));
  const ids = new Map();
  for (const line of appLines) for (const file of [line.a, line.b]) if (!ids.has(file)) ids.set(file, await hashOf(file).catch(() => file));
  const picks = [...await readLines(path.join(HERE, "picks.jsonl")), ...appLines.map((line) => fromAppPick(line, (file) => ids.get(file)))];
  const summary = ladder(records, picks, { ownerWeight });
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "ladder.json"), `${JSON.stringify({ at: new Date().toISOString(), ownerWeight, ...summary }, null, 1)}\n`);
  console.log(`${summary.judged} judged pairs, ${summary.ownerPicks.all} owner picks (${summary.ownerPicks.examples} examples, ${summary.ownerPicks.heldOut} held out${summary.ownerPicks.bothBad ? `; ${summary.ownerPicks.bothBad} both bad, counted as ties` : ""})`);
  for (const [id, rating] of Object.entries(summary.ratings)) console.log(`  ${String(rating).padStart(7)}  ${summary.names[id] ?? id}`);
  const { matched, compared, missing } = summary.agreement;
  const seen = summary.examplesAgreement;
  if (seen.compared) console.log(`judge vs example owner picks (not held out): ${seen.matched} of ${seen.compared} agree`);
  console.log(`judge vs held-out owner picks: ${matched} of ${compared} agree${missing ? ` (${missing} picks have no judge verdict yet)` : ""}; ${summary.calibrated ? "calibrated" : "advisory (needs 16 of 20)"}`);
}
