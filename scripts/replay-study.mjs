// Hand-run, not part of npm test. Do the measures kino took at the "most replayed" humps differ
// from the same measures at random times of the same videos?
//   node scripts/replay-study.mjs <data folder> [--seed 20261112] [--draws 5000]
// Reads every <data>/inspire/*.json that holds a replay graph, takes each video's top humps (the
// start is left apart), and prints per measure: how many videos, the mean at the humps, the mean at
// random times (as many per video as it has humps, from 3 s to the end of what kino measured), the
// difference, and how often chance gives a difference as large (a seeded permutation test). With
// fewer than 15 graphs it prints the numbers and says the sample is too small to conclude anything.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MEASURES, replayStudy } from "../backend/measure/replay-graph.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? Number(args[at + 1]) : fallback; };
const folder = args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
if (!folder) { console.error("usage: node scripts/replay-study.mjs <data folder> [--seed N] [--draws N]"); process.exit(2); }

const directory = path.join(folder, "inspire");
const refs = [];
let records = 0;
for (const name of (await readdir(directory)).filter((file) => /^[\w-]{11}\.json$/.test(file))) {
  try {
    const record = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    records += 1;
    if (record.replay) refs.push(record);
  } catch { /* a file that is not a reference */ }
}

const study = replayStudy(refs, { seed: flag("seed", 20261112), draws: flag("draws", 5000) });
console.log(`${records} references in ${directory}; ${refs.length} carry a replay graph; ${study.n} have humps inside the measured stretch (${study.humps} humps).`);
for (const row of study.rows) {
  console.log(row.n
    ? `${row.measure} (${MEASURES[row.measure]}): n=${row.n} videos, humps ${row.hump}, random times ${row.random}, difference ${row.difference}, chance gives as much in ${Math.round(row.chance * 100)}% of draws`
    : `${row.measure} (${MEASURES[row.measure]}): not measured on any of them`);
}
if (study.tooSmall) console.log(`n=${study.n} is fewer than ${study.minimum} graphs: the sample is too small to conclude anything. These are the numbers, not a finding.`);
