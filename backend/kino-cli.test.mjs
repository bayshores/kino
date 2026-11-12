// Tests the kino command line: word parsing, real commands against a test server, and `kino setup` with stand-in agents.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exitCodeFor, parseCommand, UsageError } from "../bin/kino.mjs";
import { planSetup } from "../bin/setup.mjs";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "kino.mjs");
const skillSource = path.join(root, "skills", "kino");
// setup's default preview file. No test may create or change it.
const realLaunchFolder = path.join(root, ".claude");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A real 1×1 PNG for the import test.
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// Every temporary folder this file makes, removed at the end.
const folders = [];
async function tempFolder(prefix) {
  const folder = await mkdtemp(path.join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}
const launchFolderExisted = existsSync(realLaunchFolder);
after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
  assert.equal(existsSync(realLaunchFolder), launchFolderExisted, "the checkout's .claude folder was left alone");
});

// The environment without any kino settings from the computer running the tests.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ["MOTION_API_URL", "KINO_OWNER_TOKEN", "KINO_SHARE_TOKEN", "KINO_RUNTIME_FILE", "KINO_METER_FILE", "KINO_SETUP_HOME"])
    delete env[name];
  return { ...env, ...extra };
}

// Runs `node bin/kino.mjs ...args` and collects what it prints and its exit code.
function runKino(args, { env, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

describe("parseCommand", () => {
  test("turns command-line words into a verb, its input and options", async () => {
    const home = process.env.HOME ?? "~";
    const cases = [
      [["status"], { verb: "status", input: {}, options: { json: false, you: false } }],
      [["status", "--project=demo"], { verb: "status", input: { project: "demo" }, options: { json: false, you: false, project: "demo" } }],
      [["check", "s2", "--json"], { verb: "check", input: { scene: "s2" }, options: { json: true, you: false } }],
      [["look", "sheet", "s2"], { verb: "look", input: { mode: "sheet", scene: "s2" } }],
      [["look", "frame", "t=2.5", "width=320"], { verb: "look", input: { mode: "frame", t: 2.5, width: 320 } }],
      [["look", '{"mode":"zoom","layer":"logo"}'], { verb: "look", input: { mode: "zoom", layer: "logo" } }],
      [["inspect", "title", "text[fontSize>40]", "*[name~=title]"], { verb: "inspect", input: { targets: ["title", "text[fontSize>40]", "*[name~=title]"] } }],
      [["library", "op", "add_animation"], { verb: "library", input: { topic: "op", name: "add_animation" } }],
      [["history", "revert", "T3"], { verb: "history", input: { action: "revert", turn: "T3" } }],
      [["history", "restore", "4"], { verb: "history", input: { action: "restore", rev: 4 } }],
      [["notes", "add", "Make the logo bigger", "layer=logo"], { verb: "notes", input: { action: "add", text: "Make the logo bigger", layer: "logo" } }],
      [["notes", "reply", "N2", "Done,", "it", "is", "red"], { verb: "notes", input: { action: "reply", id: "N2", text: "Done, it is red" } }],
      [["notes", "resolve", "N2"], { verb: "notes", input: { action: "resolve", id: "N2" } }],
      [["notes", "set_plan", "Draft the scene", "Polish timing"], { verb: "notes", input: { action: "set_plan", steps: ["Draft the scene", "Polish timing"] } }],
      [["--you", "notes", "add", "Slower"], { verb: "notes", input: { action: "add", text: "Slower" }, options: { json: false, you: true } }],
      [["project", "create", "id=launch", "name=Launch", "duration=15"], { verb: "project", input: { action: "create", id: "launch", name: "Launch", duration: 15 } }],
      [["project", "import", "logo.png"], { verb: "project", input: { action: "import", file: path.resolve("logo.png") } }],
      // path=, source= and file= name the file too; a library sound's id stays as typed.
      [["project", "import", "path=/abs/song.wav"], { verb: "project", input: { action: "import", file: "/abs/song.wav" } }],
      [["project", "import", "file=logo.png"], { verb: "project", input: { action: "import", file: path.resolve("logo.png") } }],
      [["project", "import", "source=yt:abc123"], { verb: "project", input: { action: "import", file: "yt:abc123" } }],
      [["project", "import", "source=sfx:swish-3"], { verb: "project", input: { action: "import", file: "sfx:swish-3" } }],
      [["project", "import", "music:calm-1"], { verb: "project", input: { action: "import", file: "music:calm-1" } }],
      // Found footage codes go to the server as typed, not as a path in the current folder.
      [["project", "import", "file=F1"], { verb: "project", input: { action: "import", file: "F1" } }],
      [["project", "import", "file=F1.15"], { verb: "project", input: { action: "import", file: "F1.15" } }],
      [["project", "import", '{"action":"import","file":"F13","options":{"shots":[83,64]}}'], { verb: "project", input: { action: "import", file: "F13", options: { shots: [83, 64] } } }],
      [["project", "import", "file=clip:abc"], { verb: "project", input: { action: "import", file: "clip:abc" } }],
      [["project", "record", "start", 'target={"app":"Notes"}', "maxSeconds=60"], { verb: "project", input: { action: "record", options: { target: { app: "Notes" }, maxSeconds: 60, step: "start" } } }],
      [["project", "record", "mark", "Open", "the", "menu"], { verb: "project", input: { action: "record", options: { step: "mark", label: "Open the menu" } } }],
      // zsh leaves the ~ after = as typed; it is the home folder, as in out=~/Movies.
      [["project", "import", "path=~/song.wav"], { verb: "project", input: { action: "import", file: path.join(home, "song.wav") } }],
      // layer= and layers= are other names for inspect's targets.
      [["inspect", "layer=walk-3"], { verb: "inspect", input: { targets: "walk-3" } }],
      [["inspect", "layers=walk-3,walk-4", "fields=x"], { verb: "inspect", input: { targets: "walk-3,walk-4", fields: "x" } }],
      // Names after a comma and a space, or after another word, join the targets (walk-3 was dropped).
      [["inspect", "layers=walk-3,", "walk-4"], { verb: "inspect", input: { targets: ["walk-3", "walk-4"] } }],
      [["inspect", "walk-3", "layer=walk-4"], { verb: "inspect", input: { targets: ["walk-4", "walk-3"] } }],
      [["render", "start", "quality=final", "out=~/Movies"], { verb: "render", input: { action: "start", quality: "final", out: path.join(home, "Movies") } }],
      // The service only takes absolute out folders, so a relative one is read from the folder kino runs in.
      [["render", "start", "out=renders"], { verb: "render", input: { action: "start", out: path.resolve("renders") } }],
      [["project", "manage", 'options={"resource":"exports","action":"start","out":"exports"}'], { verb: "project", input: { action: "manage", options: { resource: "exports", action: "start", out: path.resolve("exports") } } }],
      [["project", "manage", "id=demo", 'options={"resource":"exports","out":"~/Movies"}'], { verb: "project", input: { action: "manage", id: "demo", options: { resource: "exports", out: path.join(home, "Movies") } } }],
      [["render", "wait", "R1"], { verb: "render", input: { action: "wait", job: "R1" } }],
      // check's rules is true or a list: a comma list is the codes ("a,b" was one code, so nothing matched).
      [["check", "rules=contrast,overlap"], { verb: "check", input: { rules: ["contrast", "overlap"] } }],
      [["check", "rules=contrast"], { verb: "check", input: { rules: ["contrast"] } }],
      [["check", "rules=true"], { verb: "check", input: { rules: true } }],
    ];
    for (const [argv, expected] of cases) {
      const parsed = await parseCommand(argv);
      assert.equal(parsed.verb, expected.verb, argv.join(" "));
      assert.deepEqual(parsed.input, expected.input, argv.join(" "));
      if (expected.options) assert.deepEqual(parsed.options, expected.options, argv.join(" "));
    }
    // A canceled render exits 1 like a failed one (it exited 0); the answer to cancel itself is 0.
    const canceled = { text: "R1 draft canceled", data: { job: "R1", status: "canceled" } };
    assert.equal(exitCodeFor("render", { action: "wait", job: "R1" }, canceled), 1);
    assert.equal(exitCodeFor("render", { action: "cancel", job: "R1" }, canceled), 0);
    assert.equal(exitCodeFor("render", { action: "wait", job: "R1" }, { text: "done", data: { status: "done" } }), 0);
  });

  test("edit reads operations inline, as an object with fields, or from a file", async () => {
    const ops = [{ op: "update_layer", layer: "title", properties: { fill: "#ff5500" } }];
    assert.deepEqual(await parseCommand(["edit", JSON.stringify(ops), "--project", "demo"]), {
      verb: "edit", input: { project: "demo", ops }, options: { json: false, you: false, project: "demo" },
    });
    // An object is merged, so rev and dry_run can ride along; key=value works too.
    assert.deepEqual((await parseCommand(["edit", JSON.stringify({ ops, rev: 3 })])).input, { ops, rev: 3 });
    assert.deepEqual((await parseCommand(["edit", "dry_run=true", JSON.stringify(ops)])).input, { dry_run: true, ops });

    const folder = await tempFolder("kino-cli-ops-");
    const file = path.join(folder, "ops.json");
    await writeFile(file, JSON.stringify(ops));
    assert.deepEqual((await parseCommand(["edit", file])).input, { ops });
  });

  test("--json, --you and --project work before or after the verb", async () => {
    const ops = [{ op: "update_layer", layer: "title", properties: { fill: "#ff5500" } }];
    const expected = { verb: "edit", input: { project: "demo", ops }, options: { json: true, you: false, project: "demo" } };
    assert.deepEqual(await parseCommand(["--project", "demo", "--json", "edit", JSON.stringify(ops)]), expected);
    assert.deepEqual(await parseCommand(["--project=demo", "edit", JSON.stringify(ops), "--json"]), expected);
    assert.deepEqual(await parseCommand(["edit", "--json", JSON.stringify(ops), "--project", "demo"]), expected);
    // A --project with no id is refused, not read as "the open project".
    for (const argv of [["status", "--project"], ["--project=", "status"], ["status", "--project", "--json"]])
      await assert.rejects(parseCommand(argv), /^Error: --project needs a project id/, argv.join(" "));
  });

  test("an unknown --flag is refused with the key=value form, never read as a name", async () => {
    const cases = [
      // `--time 3` once became the scene "--time", and the 3 was dropped.
      [["look", "frame", "--time", "3"], "kino look frame t=3"],
      [["look", "frame", "--time=3"], "kino look frame t=3"],
      [["look", "frame", "-t", "3"], "kino look frame t=3"],
      // quality was lost: the job became "--quality".
      [["render", "start", "--quality", "final"], "kino render start quality=final"],
      // A true/false field does not take the ops as its value.
      [["edit", "--dry-run", "ops.json"], "kino edit dry_run=true ops.json"],
      [["look", "--mode", "zoom", "--layer", "logo"], "kino look mode=zoom layer=logo"],
      // Real options stay where they were typed.
      [["--project", "demo", "look", "sheet", "--scene", "s2", "--json"], "kino --project demo look sheet scene=s2 --json"],
    ];
    for (const [argv, suggestion] of cases) {
      await assert.rejects(parseCommand(argv), (error) => {
        assert.ok(error instanceof UsageError, argv.join(" "));
        assert.match(error.message, /^Unknown options? "-/, argv.join(" "));
        assert.ok(error.message.includes(`kino takes fields as key=value: ${suggestion} (kino help)`), `${argv.join(" ")}: ${error.message}`);
        return true;
      });
    }
    // Words that only look a little like options still work.
    assert.deepEqual((await parseCommand(["notes", "add", "-5"])).input, { action: "add", text: "-5" });
    assert.deepEqual((await parseCommand(["notes", "add", "Use -5 px"])).input, { action: "add", text: "Use -5 px" });
    // (`kino edit -` still reads stdin: the "edit inline and from stdin" test below sends it.)
  });

  // From a review of agent edits: every word was checked, so a note's text with "-bold" in it was
  // refused; any flag got some field (`history --limit 5` became action=5, which fails); and
  // `--you=true` and a bare `--` were not explained.
  test("a note's text is kept as typed, and a flag close to no field lists the fields instead", async () => {
    const notes = [
      [["notes", "add", "Make", "the", "text", "-bold"], { action: "add", text: "Make the text -bold" }],
      [["notes", "add", "-bold", "move"], { action: "add", text: "-bold move" }],
      [["notes", "reply", "N1", "-really", "good"], { action: "reply", id: "N1", text: "-really good" }],
      [["notes", "action=add", "Make", "it", "--big"], { action: "add", text: "Make it --big" }],
      // A place given as key=value is skipped (before, the text lost its first word).
      [["notes", "action=add", "Make", "it", "big"], { action: "add", text: "Make it big" }],
      [["look", "mode=frame", "s2"], { mode: "frame", scene: "s2" }],
    ];
    for (const [argv, input] of notes) assert.deepEqual((await parseCommand(argv)).input, input, argv.join(" "));
    const refused = [
      // Before the text starts, an option is still an option (one dash only for a field's name).
      [["notes", "add", "--layer", "logo", "Make", "it", "big"], 'Unknown option "--layer". kino takes fields as key=value: kino notes add layer=logo Make it big (kino help)'],
      [["notes", "add", "-t", "3", "Fix", "this"], 'Unknown option "-t". kino takes fields as key=value: kino notes add t=3 Fix this (kino help)'],
      [["history", "--limit", "5"], 'Unknown option "--limit". kino takes fields as key=value, and the fields of history are action, turn and rev. (kino help)'],
      [["inspect", "-logo"], 'Unknown option "-logo". kino takes fields as key=value, and the fields of inspect are targets and fields. (kino help)'],
      [["look", "--type", "zoom"], 'Unknown option "--type". kino takes fields as key=value, and the fields of look are mode, scene, t, from, to, layer, anim, every, ref, rev, width and page. (kino help)'],
      [["look", "frame", "--you=true"], 'Unknown option "--you=true" (--you takes no value). kino takes fields as key=value: kino look frame --you (kino help)'],
      [["look", "frame", "--"], 'Unknown option "--" (not needed). kino takes fields as key=value: kino look frame (kino help)'],
      [["look", "--mode", "--layer", "logo"], 'Unknown options "--mode", "--layer". kino takes fields as key=value: kino look mode=<value> layer=logo (kino help)'],
      // Close names still get their field.
      [["render", "start", "--motion-blur"], 'Unknown option "--motion-blur". kino takes fields as key=value: kino render start motionBlur=<value> (kino help)'],
      [["render", "start", "--wait"], 'Unknown option "--wait". kino takes fields as key=value: kino render start wait=true (kino help)'],
      [["edit", "--dry", "ops.json"], 'Unknown option "--dry". kino takes fields as key=value: kino edit dry_run=true ops.json (kino help)'],
      [["look", "frame", "--layers", "logo"], 'Unknown option "--layers". kino takes fields as key=value: kino look frame layer=logo (kino help)'],
      [["look", "frame", "--at", "2"], 'Unknown option "--at". kino takes fields as key=value: kino look frame t=2 (kino help)'],
      // A list field is written as a JSON list (fields=name was once dropped by the service).
      [["inspect", "title", "--fields", "name"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\"]' (kino help)"],
      [["inspect", "title", "--fields=[\"name\",\"x\"]"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"x\"]' (kino help)"],
      // Names with commas are one item each (the suggestion was 'fields=["name,width"]': one field
      // called "name,width", which answered null).
      [["inspect", "title", "--fields", "name,width"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\"]' (kino help)"],
      [["inspect", "title", "--fields=name, x"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"x\"]' (kino help)"],
      // A value that ends with a comma goes on in the next words (the shell splits "name, width";
      // the suggestion was 'fields=["name"]' width, which inspected name only).
      [["inspect", "title", "--fields", "name,", "width"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\"]' (kino help)"],
      [["inspect", "title", "--fields=name,", "width,", "x", "--json"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\",\"x\"]' --json (kino help)"],
      // So does a next word that starts with a comma (the suggestion was 'fields=["name"]' , width,
      // which inspected a layer called ",").
      [["inspect", "title", "--fields", "name", ",", "width"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\"]' (kino help)"],
      [["inspect", "title", "--fields", "name", ",width"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\"]' (kino help)"],
      [["inspect", "title", "fields=name,", "width", "--fields", "x"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\",\"x\"]' (kino help)"],
      // A repeated list flag is one list (it was 'fields=["name"]' 'fields=["width"]', and the
      // second word replaced the first, so inspect answered width only).
      [["inspect", "title", "--fields", "name", "--fields", "width"], "Unknown options \"--fields\", \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\"]' (kino help)"],
      [["inspect", "title", "--fields", "name,x", "--fields=[\"width\",\"x\"]"], "Unknown options \"--fields\", \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"x\",\"width\"]' (kino help)"],
      // A flag after a fields= word already there joins its list (the suggestion was
      // 'fields=["name","width"]' 'fields=["height"]', and the second word replaced the first).
      [["inspect", "title", "fields=[\"name\",\"width\"]", "--fields", "height"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\",\"height\"]' (kino help)"],
      [["inspect", "title", "fields=name,width", "--fields", "width,x"], "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"name\",\"width\",\"x\"]' (kino help)"],
      // After a note's text a flag that names a notes field is still refused (it was saved as
      // text: "Make it big --layer logo"), and an action given as a flag says where it goes.
      [["notes", "add", "Make it big", "--layer", "logo"], "Unknown option \"--layer\". kino takes fields as key=value: kino notes add 'Make it big' layer=logo (kino help)"],
      [["notes", "add", "Make it big", "--layer=logo"], "Unknown option \"--layer\". kino takes fields as key=value: kino notes add 'Make it big' layer=logo (kino help)"],
      [["notes", "add", "Make it big", "--time", "3"], "Unknown option \"--time\". kino takes fields as key=value: kino notes add 'Make it big' t=3 (kino help)"],
      [["notes", "add", "Make", "it", "--big", "--t=2"], 'Unknown option "--t". kino takes fields as key=value: kino notes add Make it --big t=2 (kino help)'],
      [["notes", "reply", "N1", "Thanks", "--resolve"], 'Unknown option "--resolve". resolve is a notes action, the word after notes: kino notes resolve <id> [text] (kino help)'],
    ];
    for (const [argv, message] of refused) {
      await assert.rejects(parseCommand(argv), (error) => {
        assert.ok(error instanceof UsageError, argv.join(" "));
        assert.equal(error.message, message);
        return true;
      });
    }
  });

  test("a list field given twice as key=value is one list", async () => {
    // Before, the last word replaced the first: inspect answered height only.
    assert.deepEqual((await parseCommand(["inspect", "tag", "fields=[\"name\",\"width\"]", "fields=[\"height\"]"])).input, { targets: ["tag"], fields: ["name", "width", "height"] });
    assert.deepEqual((await parseCommand(["inspect", "tag", "fields=name", "fields=width,name"])).input, { targets: ["tag"], fields: ["name", "width"] });
    assert.deepEqual((await parseCommand(["inspect", "tag", "fields=name"])).input, { targets: ["tag"], fields: "name" });
    // A field that is not a list keeps the last value.
    assert.deepEqual((await parseCommand(["look", "frame", "t=1", "t=2"])).input, { mode: "frame", t: 2 });
  });

  test("fields=name, width (split by the shell at the space) is one list, not a field and a target", async () => {
    // Before, width became a target: inspect answered "No layer, animation or scene \"width\"".
    assert.deepEqual((await parseCommand(["inspect", "tag", "fields=name,", "width"])).input, { targets: ["tag"], fields: "name,width" });
    assert.deepEqual((await parseCommand(["inspect", "tag", "fields=name", ",", "width", "logo"])).input, { targets: ["tag", "logo"], fields: "name,width" });
    assert.deepEqual((await parseCommand(["inspect", "tag", "fields=name", ",width"])).input, { targets: ["tag"], fields: "name,width" });
    // A word after the list that does not go on from a comma is still a target.
    assert.deepEqual((await parseCommand(["inspect", "tag", "fields=name", "logo"])).input, { targets: ["tag", "logo"], fields: "name" });
  });

  test("after a comma, fields takes the next word only when inspect knows it as a field, so fields=x, tagline is tagline's x", async () => {
    // Before, any word after a comma went into the list: tagline became a field, inspect had no
    // target, and answered "targets lists 1 to 10 names".
    assert.deepEqual((await parseCommand(["inspect", "fields=x,", "tagline"])).input, { targets: ["tagline"], fields: "x" });
    assert.deepEqual((await parseCommand(["inspect", "fields=x", ",", "tagline"])).input, { targets: ["tagline"], fields: "x" });
    // Fields, names edit reads as fields (color, size) and paths (size.width) go on.
    assert.deepEqual((await parseCommand(["inspect", "fields=x,", "size.width,", "color", "tagline"])).input, { targets: ["tagline"], fields: "x,size.width,color" });
    assert.deepEqual((await parseCommand(["inspect", "tagline", "fields=name,", "text"])).input, { targets: ["tagline"], fields: "name,text" });
    // Each word read after a comma is a guess, kept for the note an error prints.
    assert.deepEqual((await parseCommand(["inspect", "fields=name,", "width,", "tagline"])).guesses,
      [{ word: "width,", list: "fields", joined: true }, { word: "tagline", list: "fields", joined: false }]);
    assert.equal((await parseCommand(["inspect", "tagline", "fields=name,width"])).guesses, undefined);
    // --fields x, tagline: the command kino suggests reads tagline as the target too.
    await assert.rejects(parseCommand(["inspect", "--fields", "x,", "tagline"]),
      { message: "Unknown option \"--fields\". kino takes fields as key=value: kino inspect 'fields=[\"x\"]' tagline (kino help)" });
    // A step is text and an op list is JSON, so any word after a comma goes on there.
    assert.deepEqual((await parseCommand(["notes", "action=set_plan", "steps=Draft the logo,", "Polish"])).input, { action: "set_plan", steps: "Draft the logo,Polish" });
    // Unquoted steps: the words after steps= are more of it (only "Draft" was kept), and commas
    // between words separate steps; a quoted step keeps its comma.
    const steps = async (...words) => (await parseCommand(["notes", "set_plan", ...words])).input.steps;
    assert.deepEqual(await steps("steps=Draft", "the", "logo,", "Polish", "timing"), ["Draft the logo", "Polish timing"]);
    assert.deepEqual(await steps("Draft", "the", "logo,", "Polish"), ["Draft the logo", "Polish"]);
    assert.deepEqual(await steps("a,b"), ["a", "b"]);
    assert.deepEqual(await steps("Build, then check", "Render"), ["Build, then check", "Render"]);
    const ops = [{ op: "delete_layer", layer: "a" }, { op: "delete_layer", layer: "b" }];
    assert.deepEqual((await parseCommand(["edit", `ops=[${JSON.stringify(ops[0])},`, `${JSON.stringify(ops[1])}]`])).input, { ops });
  });

  test("fields=x, shadow asks for shadow's x when no other word names a target, though shadow is also a field", async () => {
    // Before, shadow (and text, label, size, any field name) went on into the list, inspect had
    // no target and answered "targets lists 1 to 10 names"; main asked for shadow's x.
    for (const name of ["shadow", "text", "label", "image", "size", "color"]) {
      const read = await parseCommand(["inspect", "fields=x,", name]);
      assert.deepEqual(read.input, { targets: [name], fields: "x" }, name);
      assert.deepEqual(read.guesses, [{ word: name, list: "fields", joined: false, target: true }]);
    }
    assert.deepEqual((await parseCommand(["inspect", "fields=x", ",", "shadow"])).input, { targets: ["shadow"], fields: "x" });
    assert.deepEqual((await parseCommand(["inspect", "fields=x,", "y,", "shadow"])).input, { targets: ["shadow"], fields: "x,y" });
    // With a target elsewhere, the list still goes on.
    assert.deepEqual((await parseCommand(["inspect", "box", "fields=name,", "width"])).input, { targets: ["box"], fields: "name,width" });
    assert.deepEqual((await parseCommand(["inspect", "fields=x,", "shadow", "box"])).input, { targets: ["box"], fields: "x,shadow" });
    assert.deepEqual((await parseCommand(["inspect", "targets=box", "fields=name,", "width"])).input, { targets: "box", fields: "name,width" });
    // The suggested command for --fields x, shadow reads shadow as the target again.
    await assert.rejects(parseCommand(["inspect", "--fields", "x,", "shadow"]),
      { message: "Unknown option \"--fields\". kino takes fields as key=value: kino inspect 'fields=[\"x\"]' shadow (kino help)" });
    await assert.rejects(parseCommand(["inspect", "title", "--fields", "x,", "shadow"]),
      { message: "Unknown option \"--fields\". kino takes fields as key=value: kino inspect title 'fields=[\"x\",\"shadow\"]' (kino help)" });
  });

  test("a note that looks like a number keeps its exact text", async () => {
    assert.deepEqual((await parseCommand(["notes", "add", "1.50"])).input, { action: "add", text: "1.50" });
    assert.deepEqual((await parseCommand(["notes", "add", "null"])).input, { action: "add", text: "null" });
  });
});

describe("commands against a running kino", () => {
  let server;
  let env;
  before(async () => {
    server = await startTestServer();
    const home = await tempFolder("kino-cli-home-");
    env = cleanEnv({ MOTION_API_URL: server.baseUrl, KINO_OWNER_TOKEN: server.ownerToken, KINO_RUNTIME_FILE: "/nonexistent", HOME: home });
  });
  after(() => server?.stop());

  async function savedLayers(projectId) {
    const response = await server.api(`/api/projects/${projectId}`);
    assert.equal(response.status, 200);
    return (await response.json()).document.scenes[0].layers;
  }

  test("project create, edit inline and from stdin, then status shows the result", async () => {
    const created = await runKino(["project", "create", "id=cli-demo", "name=CLI demo", "width=320", "height=180", "duration=2"], { env });
    assert.deepEqual({ ...created, stdout: created.stdout.split("\n")[0] }, { code: 0, stdout: "created cli-demo rev 1 and opened it · s1 320×180 2s bg #ffffff", stderr: "" });

    const inline = await runKino(["edit", JSON.stringify([{ op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 40, y: 30, width: 80, height: 60 } }])], { env });
    assert.equal(inline.code, 0, inline.stderr);
    const receipt = JSON.parse(inline.stdout);
    assert.equal(receipt.rev, 2);
    assert.deepEqual(receipt.created, { box: "L1" });

    const piped = await runKino(["edit", "-"], { env, input: JSON.stringify([{ op: "update_layer", layer: "L1", properties: { fill: "#ff0000" } }]) });
    assert.equal(piped.code, 0, piped.stderr);
    assert.equal(JSON.parse(piped.stdout).rev, 3);
    const [box] = await savedLayers("cli-demo");
    assert.equal(box.id, "box");
    assert.equal(box.fill, "#ff0000");

    const status = await runKino(["status"], { env });
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.stdout, [
      "CLI demo (cli-demo) rev 3 · 1 scene · 1 layer · 0 anims",
      // Where the video stands (the brief from the chat), right after the header.
      "direction: no brief · replies 0/10",
      // It has a layer already: a change to an existing video, not a new one.
      "step: a change to this video needs no brief",
      "s1 'Scene 1' 320×180 2s bg #ffffff · 1 layer · 0 anims",
      "  L1 box rectangle 40,30 80×60 #ff0000",
      // The new project's white background is pure #ffffff, which the quality checker warns about.
      // status renders no frames, so it says contrast and flashing are not in its count.
      "checks 0 err · 1 warn (pure_frame s1.background) · unchecked: contrast, flashing, luma_jump, frozen_picture",
      'next: check {"fix":"auto"}',
      "",
    ].join("\n"));
  });


  test("--json prints the whole reply as JSON", async () => {
    // The layer was read already, so status folds it; full=true repeats it.
    const folded = JSON.parse((await runKino(["status", "--json"], { env })).stdout);
    assert.match(folded.text, /\[1 layer unchanged since you last read them; status \{full:true\} repeats them\]/);
    const result = await runKino(["status", "full=true", "--json"], { env });
    assert.equal(result.code, 0, result.stderr);
    const reply = JSON.parse(result.stdout);
    assert.match(reply.text, /^ {2}L1 box rectangle 40,30 80×60 #ff0000$/m);
    assert.equal(reply.isError, undefined);
  });

  test("look sheet prints the path of a PNG it saved; --json leaves the image data out", async () => {
    const result = await runKino(["look", "sheet"], { env });
    assert.equal(result.code, 0, result.stderr);
    const file = result.stdout.match(/(\/\S+\.png)/)?.[1];
    assert.ok(file, `a PNG path is printed: ${result.stdout}`);
    assert.ok(existsSync(file), `${file} exists`);
    assert.deepEqual((await readFile(file)).subarray(0, 8), PNG_SIGNATURE);

    const json = JSON.parse((await runKino(["look", "sheet", "--json"], { env })).stdout);
    assert.equal(json.images.length, 1);
    assert.ok(existsSync(json.images[0].path));
    assert.equal("data" in json.images[0], false);
  });

  test("--you sends a note as the person, and the agent finds it in its next reply", async () => {
    const sent = await runKino(["notes", "add", "Make the box blue", "--you"], { env });
    assert.equal(sent.code, 0, sent.stderr);
    const next = await runKino(["status"], { env });
    assert.match(next.stdout, /\ninbox ◆1\n {2}N1 note "Make the box blue" · when done: notes \{action:"reply", id:"N1", text\}\nnext: [^\n]*\n$/);
  });

  test("project import uploads a file and says how to add it", async () => {
    const folder = await tempFolder("kino-cli-media-");
    const file = path.join(folder, "pixel.png");
    await writeFile(file, TINY_PNG);
    const result = await runKino(["project", "import", file], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^imported pixel\.png \(1×1\) as (\S+)\. Add it: edit \{ops:\[\{op:"add_layer", layerType:"image", name, properties:\{src:"\1", x:0, y:0, width:1, height:1\}\}\]\}\n$/);
  });

  test("project import of audio and video says the measured duration, and the video's size", { skip: skipWithoutMediaTools }, async () => {
    const folder = await tempFolder("kino-cli-timed-media-");
    const tone = path.join(folder, "tone.wav");
    const clip = path.join(folder, "clip.mp4");
    // FFmpeg makes 2.5 s of a 440 Hz tone and a 3 s 320×180 test-pattern video.
    await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5", tone]);
    await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);

    const audio = await runKino(["project", "import", tone], { env });
    assert.equal(audio.code, 0, audio.stderr);
    assert.match(audio.stdout, /^imported tone\.wav \(duration 2\.5s\) as (\S+)\. Add it: edit \{ops:\[\{op:"add_layer", layerType:"audio", name, properties:\{src:"\1", mediaSourceDuration:2\.5\}\}\]\}\n$/);

    const video = await runKino(["project", "import", clip], { env });
    assert.equal(video.code, 0, video.stderr);
    // A video's answer ends with its shots (backend/shot-detection.test.mjs tests them); testsrc has no cuts.
    assert.match(video.stdout, /^imported clip\.mp4 \(320×180, duration 3s\) as (\S+)\. Add it: edit \{ops:\[\{op:"add_layer", layerType:"video", name, properties:\{src:"\1", x:0, y:0, width:320, height:180, mediaSourceDuration:3\}\}\]\}\nshots: 1 \(no cuts found\) · crop with look \{mode:"source", layer\}\n$/);

    // A file kino cannot measure says so, instead of leaving the length out.
    const broken = path.join(folder, "broken.wav");
    await writeFile(broken, "this is not a sound");
    const unknown = await runKino(["project", "import", broken], { env });
    assert.equal(unknown.code, 0, unknown.stderr);
    assert.match(unknown.stdout, /^imported broken\.wav \(duration unknown\) as (\S+)\. Add it: edit \{ops:\[\{op:"add_layer", layerType:"audio", name, properties:\{src:"\1"\}\}\]\}\n$/);
  });

  test("a refused edit prints why, saves nothing and exits 1", async () => {
    const result = await runKino(["edit", JSON.stringify([{ op: "update_layer", layer: "boxx", properties: { fill: "#00ff00" } }, { op: "delete_layer", layer: "nothing-like-it" }])], { env });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /nothing-like-it/);
    const [box] = await savedLayers("cli-demo");
    assert.equal(box.fill, "#ff0000");
  });

  test("inspect fields=x, box answers box's x, and an error says which word after the comma kino took as what", async () => {
    const answer = await runKino(["inspect", "fields=x,", "box"], { env });
    assert.deepEqual(answer, { code: 0, stdout: 'rev 3\nL1 box rectangle in s1\n  x 40\nnext: edit {"ops":[{"op":"update_layer","layer":"box","properties":{"x":"<new value>"}}]}\n', stderr: "" });
    // widht is no field inspect knows, so it is read as a layer's name: the error says so.
    const misread = await runKino(["inspect", "box", "fields=x,", "widht"], { env });
    assert.equal(misread.code, 1);
    assert.match(misread.stdout, /"error":"unknown_ref","reason":"No layer, animation or scene \\"widht\\"\./);
    // Its next call keeps the fields and puts kino's suggestion where the name was sent.
    assert.match(misread.stdout, /"next":"inspect \{\\"fields\\":\\"x\\",\\"targets\\":\[\\"box\\"\]\}"/);
    assert.equal(misread.stderr, "kino took \"widht\" as a layer, animation or scene to inspect, not as one of fields: inspect has no field widht (width is one). Write fields as one word, fields=x,width, so nothing is guessed.\n");
  });

  test("an unknown command exits 2 and suggests the closest ones", async () => {
    const result = await runKino(["stauts"], { env });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Unknown command "stauts"\. Did you mean status\b[^?]*\? \(kino help\)\n$/);
  });

  test("help and --version work without a server", async () => {
    const help = await runKino([], { env: cleanEnv() });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^kino: make motion videos/);
    // The help says where options go.
    assert.match(help.stdout, /^Options go before or after the verb: kino --project launch status, kino status --project launch\.$/m);
    assert.match(help.stdout, /^ {2}--project <id> {2}act on this project instead of the open one/m);
    assert.match(help.stdout, /^Exit code: 0 when it worked; 1 when kino is not running, refused the command or the render$/m);
    const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(await runKino(["--version"], { env: cleanEnv() }), { code: 0, stdout: `${version}\n`, stderr: "" });
  });

  test("when kino is not running, a command says how to start it and exits 1", async () => {
    // A port that was just free and is now closed again.
    const port = await new Promise((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });
    const result = await runKino(["status"], { env: { ...env, MOTION_API_URL: `http://127.0.0.1:${port}` } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^kino is not running\. Open the kino app, or run `npm run dev`/);
  });

  test("an unknown option after the verb exits 2 with the right form, without a server", async () => {
    const result = await runKino(["look", "frame", "--time", "3"], { env: cleanEnv() });
    assert.deepEqual(result, { code: 2, stdout: "", stderr: 'Unknown option "--time". kino takes fields as key=value: kino look frame t=3 (kino help)\n' });
  });

  test("an unknown option before the verb names the options and exits 2", async () => {
    const result = await runKino(["--porject", "cli-demo", "status"], { env });
    assert.deepEqual(result, { code: 2, stdout: "", stderr: 'Unknown option "--porject". Options: --json, --you, --project <id>, before or after the verb. (kino help)\n' });
  });

  test("kino mcp serves the ten agent tools over stdio and reaches the server", async () => {
    const client = new Client({ name: "kino-cli-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], cwd: root, env, stderr: "ignore" }));
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ["status", "edit", "check", "look", "inspect", "render", "library", "history", "notes", "project"]);
      const status = await client.callTool({ name: "status", arguments: { project: "cli-demo", full: true } });
      assert.equal(status.isError, undefined);
      assert.match(status.content[0].text, /L1 box rectangle/);
    } finally {
      await client.close();
    }
  });

  test("options before the verb reach the service: --project edits that project, not the open one", async () => {
    const created = await runKino(["project", "create", "id=cli-other", "name=Other", "width=320", "height=180", "duration=2"], { env });
    assert.equal(created.code, 0, created.stderr);
    // Without --project, the open project (the new one) is used.
    assert.match((await runKino(["status"], { env })).stdout, /^Other \(cli-other\) rev 1/);

    const ops = JSON.stringify([{ op: "update_layer", layer: "box", properties: { fill: "#0000ff" } }]);
    const edited = await runKino(["--project", "cli-demo", "--json", "edit", ops], { env });
    assert.equal(edited.code, 0, edited.stderr);
    assert.equal(JSON.parse(edited.stdout).isError, undefined);
    assert.equal((await savedLayers("cli-demo"))[0].fill, "#0000ff");
    assert.deepEqual(await savedLayers("cli-other"), []);

    const status = await runKino(["--project=cli-demo", "--json", "status"], { env });
    assert.equal(status.code, 0, status.stderr);
    assert.match(JSON.parse(status.stdout).text, /^CLI demo \(cli-demo\) rev \d+/);
  });

  // Review round 2 of B2a: a write refused while a stop waits, or during a hold, changed nothing,
  // so a script must not carry on: `kino edit … && kino render …` stops at the refusal.
  test("a write refused while a stop waits or during a hold exits 1; status, which only names the stop, exits 0", async () => {
    const project = ["--project", "cli-stop"];
    assert.equal((await runKino(["project", "create", "id=cli-stop", "name=Stop", "width=1080", "height=1920", "duration=24", "background=#101820"], { env })).code, 0);
    const title = { op: "add_layer", layerType: "text", name: "title", properties: { text: "Park reopens Saturday", x: 140, y: 760, width: 800, height: 240, fontSize: 96, fill: "#ffffff" } };
    assert.equal((await runKino([...project, "edit", JSON.stringify([title])], { env })).code, 0);
    // A one-title video: the person said to skip the storyboard, so the agent saves that control
    // with their words and the rough cut is this video's first stop.
    const controls = { ask: "no storyboard, it is one title", controls: { skip_under: { board: 30 }, quote: "no storyboard, it is one title" } };
    const briefed = await runKino([...project, "notes", "brief", "no_playback=just start", `fields=${JSON.stringify(controls)}`], { env });
    assert.equal(briefed.code, 0, briefed.stdout + briefed.stderr);
    assert.match(briefed.stdout, /skipped for this video: board \(under 30 s\)/);
    assert.equal((await runKino([...project, "check"], { env })).code, 0);
    const asked = await runKino([...project, "notes", "checkpoint", "id=rough"], { env });
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /^waiting_for_you C1 rough/);

    const edit = await runKino([...project, "edit", JSON.stringify([{ op: "update_layer", layer: "title", properties: { y: 700 } }])], { env });
    assert.equal(edit.code, 1, edit.stdout + edit.stderr);
    assert.equal(JSON.parse(edit.stdout.split("\n")[0]).waiting, "C1");
    const render = await runKino([...project, "render", "action=start", "quality=draft"], { env });
    assert.equal(render.code, 1, render.stdout + render.stderr);
    assert.match(render.stdout, /"waiting":"C1"/);
    const status = await runKino([...project, "--json", "status"], { env });
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).data.waiting, "C1");

    const key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
    const hold = (on) => server.api("/api/dashboard/hold", { method: "POST", body: { on }, headers: { "x-kino-review": key } });
    try {
      assert.equal((await hold(true)).status, 200);
      const held = await runKino(["--project", "cli-demo", "edit", JSON.stringify([{ op: "update_layer", layer: "box", properties: { fill: "#00ff00" } }])], { env });
      assert.equal(held.code, 1, held.stdout + held.stderr);
      assert.match(held.stdout, /"held":true/);
    } finally {
      await hold(false);
    }
  });
  test("watch: notes left close together arrive as one line; pending exits 2 while they are unread", async () => {
    const child = spawn(process.execPath, [bin, "watch", "settle=2.5", "--project", "cli-demo"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const line = new Promise((resolve) => child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; if (out.includes("\n")) resolve(out); }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal((await runKino(["--you", "--project", "cli-demo", "notes", "add", "Slower"], { env })).code, 0);
      assert.equal((await runKino(["--you", "--project", "cli-demo", "notes", "add", "Bigger logo", "t=1"], { env })).code, 0);
      const printed = await Promise.race([line, new Promise((_, reject) => setTimeout(() => reject(new Error(`no line: ${out}`)), 8000))]);
      assert.match(printed, /2 new notes on cli-demo: N\d+ "Slower" · N\d+ @1s "Bigger logo"/);
      const pending = await runKino(["watch", "pending", "--project", "cli-demo"], { env });
      assert.equal(pending.code, 2);
      assert.match(pending.stderr, /2 new notes/);
    } finally { child.kill(); }
  });
});

describe("a render that fails", { skip: skipWithoutMediaTools }, () => {
  test("render start wait=true and render wait print the error and exit 1; a render that works exits 0", async () => {
    // A stand-in FFmpeg that refuses kino's video encode (frames arrive on stdin as image2pipe)
    // while a file named "broken" exists; every other call runs the real FFmpeg.
    const folder = await tempFolder("kino-cli-render-");
    const switchFile = path.join(folder, "broken");
    const brokenFfmpeg = path.join(folder, "ffmpeg.mjs");
    await writeFile(brokenFfmpeg, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("image2pipe") && existsSync(${JSON.stringify(switchFile)})) { console.error("stand-in encoder failure"); process.exit(1); }
process.exit(spawnSync(${JSON.stringify(ffmpeg)}, args, { stdio: "inherit" }).status ?? 1);
`);
    await chmod(brokenFfmpeg, 0o700);
    const server = await startTestServer({ env: { KINO_FFMPEG: brokenFfmpeg } });
    try {
      const env = cleanEnv({ MOTION_API_URL: server.baseUrl, KINO_OWNER_TOKEN: server.ownerToken, KINO_RUNTIME_FILE: "/nonexistent", HOME: await tempFolder("kino-cli-home-") });
      const out = await tempFolder("kino-cli-out-");
      assert.equal((await runKino(["project", "create", "id=cli-render", "name=Render", "width=160", "height=90", "duration=0.5"], { env })).code, 0);

      await writeFile(switchFile, "");
      const failed = await runKino(["render", "start", "wait=true", `out=${out}`], { env });
      assert.equal(failed.code, 1, failed.stdout + failed.stderr);
      assert.match(failed.stdout, /^R\d+ draft failed .*error: /);
      const job = failed.stdout.match(/^(R\d+)/)[1];
      const waited = await runKino(["render", "wait", job], { env });
      assert.equal(waited.code, 1, waited.stdout + waited.stderr);
      assert.match(waited.stdout, new RegExp(`^${job} draft failed`));

      // The same render with a working encoder: a new revision, so nothing failed is reused.
      await rm(switchFile);
      assert.equal((await runKino(["edit", JSON.stringify([{ op: "add_layer", layerType: "rectangle", name: "box", properties: { width: 40, height: 30 } }])], { env })).code, 0);
      const worked = await runKino(["render", "start", "wait=true", `out=${out}`], { env });
      assert.equal(worked.code, 0, worked.stdout + worked.stderr);
      assert.match(worked.stdout, /^R\d+ draft done /);
    } finally {
      await server.stop();
    }
  });
});

describe("kino setup with stand-in claude and codex commands", () => {
  // Writes `claude` and `codex` shell scripts that log each call. `mcp get kino` fails until
  // `mcp add` has run once, like the real commands.
  async function makeStubs() {
    const folder = await tempFolder("kino-stub-agents-");
    const log = path.join(folder, "calls.log");
    await writeFile(log, "");
    for (const name of ["claude", "codex"]) {
      const marker = path.join(folder, `${name}.added`);
      const script = `#!/bin/sh
# Stand-in for ${name} in kino's setup tests.
{ printf '%s' '${name}'; for word in "$@"; do printf '\\t%s' "$word"; done; printf '\\n'; } >> '${log}'
case "$1 $2" in
  "--version "*) echo "${name} 0.0.0 (test stand-in)"; exit 0 ;;
  "mcp get") [ -f '${marker}' ] && exit 0; echo "No MCP server named kino" >&2; exit 1 ;;
  "mcp add") : > '${marker}'; exit 0 ;;
esac
exit 3
`;
      await writeFile(path.join(folder, name), script);
      await chmod(path.join(folder, name), 0o755);
    }
    const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => line.split("\t"));
    return { folder, calls };
  }

  // Runs body with only `folder` and the system folders on PATH, then restores PATH.
  async function withPath(folder, body) {
    const before = process.env.PATH;
    process.env.PATH = `${folder}:/usr/bin:/bin`;
    try {
      return await body();
    } finally {
      process.env.PATH = before;
    }
  }

  async function filesIn(folder) {
    return (await readdir(folder, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)))
      .sort();
  }

  const isMcpAdd = (call) => call[1] === "mcp" && call[2] === "add";

  test("plans every change, applies it, and then has nothing left to do", async () => {
    const stubs = await makeStubs();
    const home = await tempFolder("kino-setup-home-");
    const launchFile = path.join(await tempFolder("kino-setup-checkout-"), ".claude", "launch.json");
    const claudeSkill = path.join(home, ".claude", "skills", "kino");
    const codexSkill = path.join(home, ".agents", "skills", "kino");

    await withPath(stubs.folder, async () => {
      const plan = await planSetup({ home, node: process.execPath, launchFile });
      assert.deepEqual(plan.found, ["Claude Code", "Codex"]);
      assert.deepEqual(plan.steps.map(({ agent, kind, describe, done, blocked }) => ({ agent, kind, describe, done, blocked })), [
        { agent: "Claude Code", kind: "mcp", describe: `run: claude mcp add --scope user kino -- ${process.execPath} ${bin} mcp`, done: undefined, blocked: undefined },
        { agent: "Claude Code", kind: "skill", describe: `copy the kino skill to ${claudeSkill}`, done: undefined, blocked: undefined },
        { agent: "Codex", kind: "mcp", describe: `run: codex mcp add kino -- ${process.execPath} ${bin} mcp`, done: undefined, blocked: undefined },
        { agent: "Codex", kind: "skill", describe: `copy the kino skill to ${codexSkill}`, done: undefined, blocked: undefined },
        { agent: "preview", kind: "launch", describe: `add a "kino" preview entry (node backend/index.mjs on port 4781) to ${launchFile}`, done: undefined, blocked: undefined },
      ]);
      // Planning only asks; it adds nothing and writes nothing.
      assert.deepEqual((await stubs.calls()).filter(isMcpAdd), []);
      assert.deepEqual(await readdir(home), []);
      assert.equal(existsSync(launchFile), false);

      for (const step of plan.steps) await step.apply();
    });

    assert.deepEqual((await stubs.calls()).filter(isMcpAdd), [
      ["claude", "mcp", "add", "--scope", "user", "kino", "--", process.execPath, bin, "mcp"],
      ["codex", "mcp", "add", "kino", "--", process.execPath, bin, "mcp"],
    ]);
    const sourceFiles = await filesIn(skillSource);
    // The references SKILL.md links to are copied with it.
    assert.ok(sourceFiles.includes(path.join("references", "edits.md")) && sourceFiles.includes(path.join("references", "fields.md")));
    for (const target of [claudeSkill, codexSkill]) {
      const skill = await readFile(path.join(target, "SKILL.md"), "utf8");
      assert.match(skill, /^name: kino$/m);
      assert.equal(skill, await readFile(path.join(skillSource, "SKILL.md"), "utf8"));
      assert.deepEqual(await filesIn(target), sourceFiles);
    }
    assert.deepEqual(JSON.parse(await readFile(launchFile, "utf8")), {
      version: "0.0.1",
      configurations: [{ name: "kino", runtimeExecutable: "node", runtimeArgs: ["backend/index.mjs"], port: 4781 }],
    });

    // Running setup again finds everything in place.
    const again = await withPath(stubs.folder, () => planSetup({ home, node: process.execPath, launchFile }));
    assert.deepEqual(again.steps.map(({ agent, kind, done, apply, blocked }) => [agent, kind, typeof done, typeof apply, blocked]), [
      ["Claude Code", "mcp", "string", "undefined", undefined],
      ["Claude Code", "skill", "string", "undefined", undefined],
      ["Codex", "mcp", "string", "undefined", undefined],
      ["Codex", "skill", "string", "undefined", undefined],
      ["preview", "launch", "string", "undefined", undefined],
    ]);
  });

  test("refuses to replace a folder that is not a kino skill, and updates an older kino skill", async () => {
    const stubs = await makeStubs();
    const home = await tempFolder("kino-setup-home-");
    const claudeSkill = path.join(home, ".claude", "skills", "kino");
    const codexSkill = path.join(home, ".agents", "skills", "kino");
    const someoneElses = "---\nname: other-tool\n---\nNot kino.\n";
    await mkdir(claudeSkill, { recursive: true });
    await writeFile(path.join(claudeSkill, "SKILL.md"), someoneElses);
    await mkdir(codexSkill, { recursive: true });
    await writeFile(path.join(codexSkill, "SKILL.md"), "---\nname: kino\n---\nAn older copy.\n");
    await writeFile(path.join(codexSkill, "old-notes.md"), "gone after the update\n");
    // A preview file that already lists another app keeps it.
    const checkout = await tempFolder("kino-setup-checkout-");
    const launchFile = path.join(checkout, "launch.json");
    await writeFile(launchFile, JSON.stringify({ version: "0.0.1", configurations: [{ name: "web", port: 3000 }] }));

    const plan = await withPath(stubs.folder, () => planSetup({ home, node: process.execPath, launchFile }));
    const step = (agent, kind) => plan.steps.find((entry) => entry.agent === agent && entry.kind === kind);
    assert.equal(step("Claude Code", "skill").blocked, `${claudeSkill} exists and is not a kino skill; move it away and run setup again`);
    assert.equal(step("Claude Code", "skill").apply, undefined);
    assert.equal(step("Codex", "skill").describe, `update the kino skill in ${codexSkill}`);

    await step("Codex", "skill").apply();
    await step("preview", "launch").apply();
    assert.deepEqual(await filesIn(codexSkill), await filesIn(skillSource));
    assert.equal(await readFile(path.join(claudeSkill, "SKILL.md"), "utf8"), someoneElses);
    assert.deepEqual(JSON.parse(await readFile(launchFile, "utf8")).configurations.map((entry) => entry.name), ["web", "kino"]);

    // A preview file that is not JSON is reported, not overwritten.
    const broken = path.join(checkout, "broken.json");
    await writeFile(broken, "{ not json");
    const blocked = await withPath(stubs.folder, () => planSetup({ home, node: process.execPath, launchFile: broken }));
    assert.equal(blocked.steps.at(-1).blocked, `${broken} is not valid JSON`);
    assert.equal(await readFile(broken, "utf8"), "{ not json");
  });

  test("with no claude or codex on PATH, only the preview entry is planned", async () => {
    const empty = await tempFolder("kino-no-agents-");
    const home = await tempFolder("kino-setup-home-");
    const launchFile = path.join(empty, "launch.json");
    const plan = await withPath(empty, () => planSetup({ home, node: process.execPath, launchFile }));
    assert.deepEqual(plan.found, []);
    assert.deepEqual(plan.steps.map(({ agent, kind }) => [agent, kind]), [["preview", "launch"]]);
  });

  test("kino setup --dry-run lists the changes and changes nothing", async () => {
    const stubs = await makeStubs();
    const home = await tempFolder("kino-setup-home-");
    // A temporary launch file, so a checkout where setup already ran plans the same steps.
    const launchFile = path.join(await tempFolder("kino-setup-launch-"), "launch.json");
    const env = { PATH: `${stubs.folder}:/usr/bin:/bin`, HOME: home, KINO_SETUP_HOME: home, KINO_SETUP_LAUNCH_FILE: launchFile };
    const result = await runKino(["setup", "--dry-run"], { env });
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.split("\n");
    assert.equal(lines[0], "Found: Claude Code, Codex.");
    assert.equal(lines[1], "Setup will:");
    assert.match(lines[2], /^ {2}1\. Claude Code: run: claude mcp add --scope user kino -- \S+ /);
    assert.ok(lines[2].endsWith(` ${bin} mcp`));
    assert.equal(lines[3], `  2. Claude Code: copy the kino skill to ${path.join(home, ".claude", "skills", "kino")}`);
    assert.match(lines[4], /^ {2}3\. Codex: run: codex mcp add kino -- \S+ /);
    assert.equal(lines[5], `  4. Codex: copy the kino skill to ${path.join(home, ".agents", "skills", "kino")}`);
    assert.equal(lines[6], `  5. preview: add a "kino" preview entry (node backend/index.mjs on port 4781) to ${launchFile}`);
    assert.equal(lines[7], "(--dry-run: nothing changed)");
    assert.equal(existsSync(launchFile), false);

    const calls = await stubs.calls();
    assert.ok(calls.some((call) => call[0] === "claude" && call[1] === "--version"));
    assert.ok(calls.some((call) => call.join(" ") === "codex mcp get kino"));
    assert.deepEqual(calls.filter(isMcpAdd), []);
    assert.deepEqual(await readdir(home), []);
    assert.equal(existsSync(realLaunchFolder), launchFolderExisted);
  });
});
