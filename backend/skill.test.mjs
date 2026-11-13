// The kino skill (skills/kino): SKILL.md stays short and links each reference one step away,
// references/fields.md matches the ops, Codex finds the skill through .agents/skills/kino, the
// guide serves each reference, and every example in the skill runs as written on a real server
// (edit ops, render calls, and lines naming a "tool", such as the brief calls in direction.md).
import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeStubPrograms } from "./crew-stub-agent.test.support.mjs";
import { after, before, test } from "node:test";
import { fieldSheet } from "../scripts/field-sheet.mjs";
import { hasMediaTools, startTestServer, withoutNext } from "./media.test.support.mjs";
import { estimateTextTokens } from "./meter.mjs";
import { SKILL_ROOT, jsonBlocks, skillFiles } from "./skill.test.support.mjs";

// SKILL.md loads whole whenever the skill is used; a reference only when a task needs it.
const SKILL_LIMIT = 7000;
const REFERENCE_LIMIT = 9000;
// References with a smaller limit in tokens (kino's estimate of the whole file, as library guide
// sends it): the direction plan's §10.
const REFERENCE_TOKENS = { "references/framing.md": 800 };

let server;
// The crew example (dashboard.md "The crew") starts a helper: stub claude and codex programs
// (crew-stub-agent.test.support.mjs) in a temporary home stand in for the real ones.
let home;
before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kino-skill-home-"));
  server = await startTestServer({ env: { HOME: home, ...(await writeStubPrograms(path.join(home, "bin"))) } });
});
after(async () => {
  await server?.stop();
  if (home) await rm(home, { recursive: true, force: true });
});

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

test("SKILL.md is short, says what kino does and when to use it, and links each reference once", () => {
  const files = skillFiles();
  const skill = files["SKILL.md"];
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
  assert.equal(/^name: (.+)$/m.exec(front)[1], "kino");
  const description = /^description: (.+)$/m.exec(front)[1];
  assert.ok(description.length <= 1024, "a description is at most 1,024 characters");
  assert.match(description, /^Makes /, "the description is in the third person");
  assert.match(description, /\. Use when /, "the description says when to use the skill");
  assert.doesNotMatch(description, /[<>]/);
  assert.ok(skill.length < SKILL_LIMIT, `SKILL.md has ${skill.length} characters (limit ${SKILL_LIMIT}): move detail into a reference`);
  assert.ok(body.split("\n").length < 500);
  // Plan §4 (review round 2): a new chat or a compacted one that resumes a video reads SKILL.md,
  // not the direction reference, so the loop's first step says to say the direction back.
  const firstStep = body.split("## The loop")[1].split(/\n2\. /)[0].replace(/\s+/g, " ");
  assert.match(firstStep, /New chat or compaction: first say its `direction:` back in one sentence, and trust it over your memory\./);
  // The look row lists only the everyday modes; the final-render gate modes live in the loop's steps.
  for (const mode of ["versus", "viewer", "critique"]) assert.match(body.split("## The loop")[1], new RegExp(`look \\{mode:"${mode}"\\}`), `the loop names look ${mode}`);

  const linked = [...skill.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map((match) => match[1]);
  const references = Object.keys(files).filter((file) => file !== "SKILL.md");
  assert.deepEqual([...linked].sort(), references, "SKILL.md links every reference once, and only files that exist");
  for (const file of references) {
    const text = files[file];
    assert.ok(text.length <= REFERENCE_LIMIT, `${file} has ${text.length} characters (limit ${REFERENCE_LIMIT}): split it`);
    if (REFERENCE_TOKENS[file]) assert.ok(estimateTextTokens(text) <= REFERENCE_TOKENS[file], `${file} is about ${estimateTextTokens(text)} tokens (limit ${REFERENCE_TOKENS[file]})`);
    assert.doesNotMatch(text, /\]\([^)]*\.md\)|references\//, `${file} links no other file, so every reference is one step from SKILL.md`);
    if (text.split("\n").length > 100)
      assert.match(text.split("\n").slice(0, 12).join("\n"), /^Contents: /m, `${file} is over 100 lines, so it starts with its contents`);
  }
});

// Milestone LIVE review rounds 1 and 2: the build order (a rough edit, up to N sections of one
// edit and one look each, one edit of fixes) stays inside the A2 eval's edit target
// (evals/run.mjs, which counts only briefs without direction). It caps the build only: the
// storyboard (B4a), a redo the person asks for at a stop (B2a) and a refused edit's retry are
// more edits, so SKILL.md sets no cap on every edit.
test("the build order fits the eval's edit target, and leaves room for the storyboard, redos and retries", () => {
  const files = skillFiles();
  const loop = files["SKILL.md"].split("## The loop")[1].split("\n## ")[0].replace(/\s+/g, " ");
  const sections = Number(/Then up to (\d+) sections, each an `edit` \+ `look \{from, to\}`/.exec(loop)?.[1]);
  const evalSource = readFileSync(new URL("../evals/run.mjs", import.meta.url), "utf8");
  const target = Number(/editCalls <= (\d+)\)/.exec(evalSource)?.[1]);
  assert.ok(sections > 0 && target > 0, "SKILL.md says its section count; evals/run.mjs its edit target");
  assert.ok(1 + sections + 1 <= target, `a rough edit, ${sections} sections and the fixes (${sections + 2} edits) fit the A2 target of ${target}`);
  assert.doesNotMatch(loop, /edits at most|at most \d+ edits/, "no cap on every edit: the storyboard, redos and retries are edits too");
  // The reference says the same numbers, and what comes on top of them.
  const reference = files["references/check-and-look.md"].split("## Building in order")[1].replace(/\s+/g, " ");
  assert.match(reference, new RegExp(`at most ${sections} sections`));
  assert.match(reference, new RegExp(`at most ${sections + 2} edits to build it; the storyboard, a redo the person asks for at a stop and a retry come on top\\.`));
  // Step 7 counts the section looks as the pass, so there is no extra whole-scene look.
  assert.match(loop, /One `look` per pass or section\./);
});

test("references/fields.md lists every op's fields as the agent service has them", () => {
  assert.equal(skillFiles()["references/fields.md"], fieldSheet(), "references/fields.md is out of date: run npm run skill:fields");
});

test("Codex finds the skill through .agents/skills/kino, a link to skills/kino, so the text has one copy", () => {
  const link = new URL("../.agents/skills/kino", import.meta.url);
  assert.ok(lstatSync(link).isSymbolicLink(), ".agents/skills/kino is a symbolic link");
  assert.equal(realpathSync(link), realpathSync(SKILL_ROOT));
});

test("library guide sends SKILL.md, and with a name one of its references", async () => {
  const files = skillFiles();
  const guide = await agent("library", { topic: "guide" });
  assert.ok(withoutNext(guide.text).startsWith(files["SKILL.md"].replace(/^---[\s\S]*?---\s*/, "")));
  assert.match(guide.text, /\nnext: \w+ \{.*\}$/, "the guide ends with the next call too");
  for (const name of ["edits", "references/sound.md", "fields", "direction"]) {
    const reference = await agent("library", { topic: "guide", name });
    assert.equal(withoutNext(reference.text), files[`references/${name.replace(/^references\//, "").replace(/\.md$/, "")}.md`]);
  }
  const missing = await agent("library", { topic: "guide", name: "edit" });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.data.didYouMean.slice(0, 1), ["edits"]);
});

// A file's text split at its # and ## headings.
function sections(text) {
  const parts = [{ heading: "", lines: [] }];
  for (const line of text.split("\n")) {
    if (/^#{1,2} /.test(line)) parts.push({ heading: line.replace(/^#+ /, ""), lines: [] });
    else parts.at(-1).lines.push(line);
  }
  return parts.map(({ heading, lines }) => ({ heading, text: lines.join("\n") }));
}

// Examples that need an imported file, a file on disk or YouTube: the test named runs them with real
// files (or a stub yt-dlp).
const MEDIA_TESTS = {
  "Captions, beats and sequences": "backend/agent-captions.test.mjs",
  "Sound effects: finding and placing them": "backend/sound-search.test.mjs",
  "Sound: volume, fades and ducking": "backend/agent-volume.test.mjs",
  "Sound: separating voice from background": "backend/agent-voice.test.mjs",
  "Clip speed: slow motion, reverse, choppy": "backend/agent-volume.test.mjs",
  "Cutting and skipping inside a clip": "backend/agent-volume.test.mjs",
  "Color grading": "backend/agent-color.test.mjs",
  "Example: a model that turns once": "backend/script-layer-export.test.mjs",
  "Subject cut-out": "backend/agent-cutout.test.mjs",
  "Follow an object": "backend/agent-cutout.test.mjs",
  "Steady shaky footage": "backend/agent-cutout.test.mjs",
  "Editing a recording": "backend/recorder.test.mjs",
  "Cleaning a voiceover": "backend/agent-speech.test.mjs",
  "Syncing two clips of the same moment": "backend/agent-sync.test.mjs",
  "Sound: music as structure": "backend/agent-volume.test.mjs",
  "Framing: crop footage to 9:16": "backend/look-source.test.mjs",
  "Storyboard: a board from footage": "backend/look-board.test.mjs",
  // Inspire searches YouTube: the test runs it with a stub yt-dlp, never online.
  "Borrowing a rhythm from YouTube": "backend/agent-inspire.test.mjs",
  "Short vertical edits (YouTube Shorts)": "backend/agent-inspire.test.mjs",
  "Fingerprint and frame strips": "backend/agent-inspire.test.mjs",
  "Proposing ideas to the person": "backend/agent-inspire.test.mjs",
  // Soundtrack search reaches Openverse and YouTube: run against a stub Openverse.
  "Search": "backend/sound-search.test.mjs",
  "Measure and compare": "backend/sound-search.test.mjs",
  "Note your verdict": "backend/sound-search.test.mjs",
  "More like a song the person likes": "backend/sound-search.test.mjs",
  "Brief and lanes": "backend/sound-search.test.mjs",
  "Explore by lanes": "backend/soundtrack.test.mjs",
  // The footage finder searches, scans and imports from YouTube: run with a stub yt-dlp.
  "Three calls": "backend/footage-finder.test.mjs",
  "Note a video": "backend/footage-finder.test.mjs",
};

test("every example in the skill runs as written", { timeout: 300_000 }, async () => {
  const problems = [];
  let ops = 0;
  for (const [file, text] of Object.entries(skillFiles())) {
    // Each file's blocks run in order on one 1920×1080 project, so later ones use earlier names.
    const base = file.replace(/^references\//, "").replace(/\.md$/, "").toLowerCase();
    const project = `skill-${base}`;
    const made = await agent("project", { action: "create", id: project, name: `Skill ${base}`, width: 1920, height: 1080, duration: 6, background: "#0b1020" });
    assert.equal(made.isError, undefined, made.text);
    for (const { heading, text: part } of sections(text)) {
      const where = `${file} "${heading}"`;
      for (const block of jsonBlocks(part)) {
        if (/\/api\/media\/<|"\/absolute\/|"topic":"inspire"|"topic":"soundtrack"|"topic":"footage"|"borrow_rhythm"/.test(JSON.stringify(block))) {
          if (!MEDIA_TESTS[heading]) problems.push(`${where}: an example with media or a file on disk needs a test that runs it with real files`);
          continue;
        }
        if (block.every((entry) => entry.tool)) {
          // Calls of any tool (direction.md): each line runs on this file's project, in order.
          // "expect" names the refusal the call must give; without it, the call must work.
          for (const { tool, expect, ...call } of block) {
            const reply = await agent(tool, { project, ...call });
            const wrong = expect ? reply.data?.error !== expect : reply.isError;
            if (wrong) problems.push(`${where}: ${tool} ${JSON.stringify(call)}${expect ? ` should be refused with ${expect}` : ""}: ${reply.text}`);
          }
        } else if (block.every((entry) => entry.op)) {
          const reply = await agent("edit", { project, ops: block });
          ops += block.length;
          if (reply.isError) problems.push(`${where}: ${reply.text}`);
          else if (reply.data.fixed) problems.push(`${where}: kino had to fix it: ${reply.data.fixed.join("; ")}`);
        } else if (block.every((entry) => entry.action)) {
          // render calls (render.md): a draft of the whole project, then its queue and the job.
          if (!hasMediaTools) continue;
          for (const call of block) {
            let reply = await agent("render", { project, ...call });
            for (let tries = 0; call.action === "wait" && !reply.isError && /still running/i.test(reply.text) && tries < 20; tries += 1)
              reply = await agent("render", { project, ...call });
            if (reply.isError) problems.push(`${where}: render ${JSON.stringify(call)}: ${reply.text}`);
          }
        } else problems.push(`${where}: a block mixes edit ops and other calls`);
      }
      // Ops written inline in the text: `{"op":…}`.
      for (const match of part.matchAll(/`(\{"op":[^`]*\})`/g)) {
        const reply = await agent("edit", { project, ops: [JSON.parse(match[1])], dry_run: true });
        ops += 1;
        if (reply.isError) problems.push(`${where}: ${reply.text}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(ops >= 25, `${ops} ops ran`);
});
