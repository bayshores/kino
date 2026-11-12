// Test helper: the person's message as the brief stores it (brief.fields.ask). A test that needs a
// briefed video past the order's first step ("save their message (ask)") saves ASK_TEXT, or adds
// it to a state with `withAsk`. The text holds the quotes of the brief fixtures in
// agent-brief.test.mjs, so those lines pass the quote check (quote_not_said).
export const ASK_TEXT = "Make a clip for my skate crew. my skate crew, they should feel like going out to skate. raw and bright, real street sound, no synth dings. no meme text and don't crop our faces out. the kickflip at the end";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { openStore } from "./store.mjs";
import { SKIP_BOARD_APPROVALS } from "./stops.test.support.mjs";

const SAVED_AT = "2026-01-01T00:00:00.000Z";

/**
 * A real agent service on a temporary data folder, for tests of what the service wires into the
 * brief, the check and the stops (never the network, never a decode). `document` is stored as the
 * project; `state` is applied to its agent state; each `media` record {id, name, width, height,
 * duration} gets an empty file and its .json record in the media folder, and is listed.
 * Returns {call, service, agentState}: call(verb, input) runs the verb on that project.
 */
export async function serviceFor(t, { document, state = null, media = [], ...deps }) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-test-wired-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const mediaRoot = path.join(dataRoot, "media");
  await mkdir(mediaRoot, { recursive: true });
  for (const record of media) {
    await writeFile(path.join(mediaRoot, record.id), "");
    await writeFile(path.join(mediaRoot, `${record.id}.json`), JSON.stringify({ kind: "video", ...record }));
  }
  const store = await openStore(dataRoot);
  await store.createProject(document);
  const agentState = createAgentStateStore(dataRoot);
  if (state) await agentState.update(document.id, state);
  const fonts = await loadBundledFonts();
  const service = createAgentService({ store, agentState, agentDirectory: path.join(dataRoot, "agent"), mediaRoot, exportBatches: {}, fontCatalog: { async loadInto() {} },
    // No people found: the real one starts a macOS helper process in a full check.
    peopleCache: { saved: async () => null, get: async () => null, savedSubjects: async () => null },
    loadFonts: async () => fonts, listMedia: async () => media.map((record) => ({ kind: "video", ...record })), approvals: SKIP_BOARD_APPROVALS, operationContext: async () => ({}),
    saveDocument: (projectId, before, saved, expectedRevision, { request, resultMetadata } = {}) => store.updateProject(projectId, saved, expectedRevision, { request, resultMetadata }), ...deps });
  const call = (verb, input = {}) => service.call(verb, { project: document.id, ...input }, { client: "claude-code" });
  return { call, service, agentState, store };
}

/** A brief's `fields` with the ask stored as the service stores it: [{text, at}]. */
export const withAsk = (fields = {}, text = ASK_TEXT) => ({ ...fields, ask: [{ text, at: SAVED_AT }] });
