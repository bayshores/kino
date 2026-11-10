// The anime edit proof, run by hand (plan .scratch/anime item 13): a made-up song and three
// made-up clips go through compose, check and render on a test server, for 3 seeds. It prints, per
// seed, the song seams and the nearest cut to each (in frames), the effect findings and the render.
// Pass: effect_fit, seam_lock and rest_fit quiet, at least one song seam in the edit (written as a
// fitted song-* cue) with a shot starting within 1 frame of every one. The 24 s edit is long enough
// for the song's break (32 s) to fall inside it. engine/footage.test.js ("anime proof") checks the
// same plan without media: seams, rests, drawn footage and the cues compose writes.
//
//   node --import ./scripts/test-fonts.mjs tests/anime-proof.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { movesApi, uploadSong } from "./moves-gate.mjs";

const FRAME = 1 / 30;
// Three 8 s clips: a box that slides right and stops on a wall (a contact), a room whose light
// comes up at 4 s, drawn on 2s (12 drawings a second), and a plain moving test picture.
const CLIPS = {
  "hit.mp4": ["-f", "lavfi", "-i", "color=c=0x202838:s=640x360:r=24:d=8", "-f", "lavfi", "-i", "color=c=white:s=60x60:r=24:d=8",
    "-filter_complex", "[0][1]overlay=x='min(20+300*t,520)':y=150,drawbox=x=580:y=0:w=60:h=360:c=0x101418:t=fill"],
  "light.mp4": ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=12:d=8", "-vf", "eq=brightness='if(lt(t,4),-0.35,-0.05)':eval=frame,fps=24"],
  "plain.mp4": ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=8"],
};

async function uploadClips(server, project) {
  const { ffmpeg, run } = await import("../backend/media.test.support.mjs");
  const folder = await mkdtemp(path.join(tmpdir(), "kino-anime-proof-"));
  try {
    const made = [];
    for (const [name, args] of Object.entries(CLIPS)) {
      const file = path.join(folder, name);
      await run(ffmpeg, ["-v", "error", "-y", ...args, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
      const response = await server.api(`/api/media?project=${project}`, { method: "POST", headers: { "Content-Type": "video/mp4", "X-File-Name": name }, body: await readFile(file) });
      assert.equal(response.status, 201);
      made.push(await response.json());
    }
    return made;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** One seed: compose, check, render. Returns its lines and whether it passed. */
export async function proveSeed(server, seed, { render = true } = {}) {
  const api = movesApi(server);
  const project = `anime-proof-${seed}`;
  const created = await api.agent(project, "project", { action: "create", id: project, name: project, width: 1280, height: 720, duration: 24 });
  assert.equal(created.isError, undefined, created.text);
  const clips = await uploadClips(server, project);
  const song = await uploadSong(server, project);
  const composed = await api.agent(project, "edit", { ops: [{ op: "compose", footage: clips.map((clip) => clip.src), music: song.src, duration: 24, treatment: "story", seed }] });
  const lines = [`seed ${seed}: ${composed.isError ? `compose refused: ${composed.text}` : "composed"}`];
  if (composed.isError) return { lines, pass: false };
  const check = await api.agent(project, "check", { rules: ["effect_fit", "seam_lock", "rest_fit"] });
  const findings = (check.text.match(/^.*(effect_fit|seam_lock|rest_fit).*$/gm) ?? []).filter((line) => !line.startsWith("Rules:"));
  lines.push(findings.length ? `findings:\n  ${findings.join("\n  ")}` : "effect_fit, seam_lock, rest_fit: quiet");
  const cues = await api.agent(project, "inspect", { targets: ["cues"] });
  // inspect lists cues as "marker 2: song-break-1 10.006, end-card 21.5"; status lists each shot's "show @10.01".
  const status = await api.agent(project, "status", {});
  const starts = [...status.text.matchAll(/ shot-\d+ [^|\n]*\| (?:A\d+ show @)([\d.]+)/g)].map((match) => Number(match[1]));
  // status rounds a time to 0.01 s, so a start within a frame plus that rounding is on the seam.
  const seams = [...cues.text.matchAll(/(song-[a-z]+(?:-[a-z]+)?-\d+) ([\d.]+)/g)].map((match) => {
    const at = Number(match[2]);
    return { name: match[1], at, off: Math.min(...starts.map((start) => Math.abs(start - at))) };
  });
  lines.push(`seams: ${seams.map((seam) => `${seam.name} ${seam.at} s, nearest shot start ${seam.off.toFixed(3)} s off`).join("; ") || "none in the edit"}`);
  let rendered = true;
  if (render) {
    const out = await mkdtemp(path.join(tmpdir(), "kino-anime-proof-render-"));
    let answer = await api.agent(project, "render", { action: "start", quality: "draft", out, wait: true });
    // A wait answers within 55 s, and its first line is "<job> draft <status> rev ...": a render still
    // running (inProgress, queued) is waited for again, up to 10 more times.
    const head = (reply) => /^(\S+) \S+ (\S+) rev /.exec(reply.text);
    for (let again = 0; again < 10 && !answer.isError; again += 1) {
      const [, job, status] = head(answer) ?? [];
      if (!job || ["done", "failed", "canceled"].includes(status)) break;
      answer = await api.agent(project, "render", { action: "wait", job });
    }
    // A render that did not end done (still running, failed, canceled or refused) is a failed seed.
    rendered = !answer.isError && head(answer)?.[2] === "done";
    lines.push(`render: ${rendered ? "" : "NOT DONE: "}${answer.isError ? answer.text : answer.text.split("\n")[0]} (delete ${out} after looking)`);
  }
  // A song with seams in the edit must give cues, and every cue needs a shot starting within one frame.
  return { lines, pass: rendered && !findings.length && seams.length > 0 && seams.every((seam) => seam.off <= FRAME + 0.006) };
}

// By hand: three seeds on a test server.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.env.KINO_MEASURE_HELPER ??= "none";
  const { startTestServer } = await import("../backend/media.test.support.mjs");
  const server = await startTestServer();
  let passed = 0;
  try {
    for (const seed of [1, 2, 3]) {
      const { lines, pass } = await proveSeed(server, seed);
      console.log(lines.join("\n"));
      if (pass) passed += 1;
    }
    console.log(`${passed} of 3 seeds pass`);
    process.exitCode = passed === 3 ? 0 : 1;
  } finally {
    await server.stop();
  }
}
