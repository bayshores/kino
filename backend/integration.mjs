// The one file other apps import to drive kino from outside, for example a screen recorder
// that hands its footage to kino as an editable project. Import this file, not kino's internal
// files: those can move or be renamed, while everything exported here keeps its name and meaning
// for as long as INTEGRATION_VERSION stays the same. A change that would break a caller raises
// INTEGRATION_VERSION, so the caller can check it and say which kino it needs.
//
// What each export is for:
// - connectAgentClient(env, {name}): finds the running kino and returns a client with
//   call(verb, input) for the ten agent tools, importFile(path) to upload media or a .motion
//   document, and tools() for the tool list (to check a feature is there before using it).
// - createLayer, createScene, createDocument, parseDocument: build a kino document (.motion)
//   that importFile can open. parseDocument checks it and fills in defaults.
// - DOCUMENT_VERSION: the document format these functions write.
// - MAX_UPLOAD_BYTES: the largest file importFile accepts.
export const INTEGRATION_VERSION = 1;
export { connectAgentClient } from "./agent/client.mjs";
export { createLayer, createScene, createDocument, parseDocument } from "../engine/model.js";
export { DOCUMENT_VERSION, MAX_UPLOAD_BYTES } from "../engine/schema.js";
