// The choices the MCP tools' schemas (tools.mjs) and the service (service.mjs) both use, so the
// MCP tool never refuses an action or topic the service and the kino command accept.

// The notes actions an agent may send. The person's own (reopen, always, stopped) come from the
// dashboard and are not listed for agents.
export const NOTES_ACTIONS = Object.freeze(["list", "set_plan", "add", "reply", "resolve", "keep", "brief", "deck", "checkpoint", "answer", "helper", "release", "judge", "try", "intents", "viewer", "critique", "verdict", "needs"]);

// The library topics ("topics" lists them).
export const LIBRARY_TOPICS = Object.freeze(["topics", "op", "rules", "search", "easings", "presets", "fonts", "media", "sounds", "music", "effects", "blocks", "moves", "guide", "inspire", "soundtrack", "techniques", "formats"]);

// What library inspire searches: edits, Shorts, or sound effects (backend/inspire.mjs uses it too).
export const SEARCH_KINDS = Object.freeze(["videos", "shorts", "sounds"]);
