// Test helper: the person's message as the brief stores it (brief.fields.ask). A test that needs a
// briefed video past the order's first step ("save their message (ask)") saves ASK_TEXT, or adds
// it to a state with `withAsk`. The text holds the quotes of the brief fixtures in
// agent-brief.test.mjs, so those lines pass the quote check (quote_not_said).
export const ASK_TEXT = "Make a clip for my skate crew. my skate crew, they should feel like going out to skate. raw and bright, real street sound, no synth dings. no meme text and don't crop our faces out. the kickflip at the end";

const SAVED_AT = "2026-01-01T00:00:00.000Z";

/** A brief's `fields` with the ask stored as the service stores it: [{text, at}]. */
export const withAsk = (fields = {}, text = ASK_TEXT) => ({ ...fields, ask: [{ text, at: SAVED_AT }] });
