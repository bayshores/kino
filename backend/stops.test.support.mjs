// The stop functions (agent/stops.mjs) for the tests about rough, color and sound. Since
// 2026-11-11 the storyboard is asked for every video of 8 s or more, with or without footage,
// so these tests' 24 s title cards would meet it first. A test video with no footage here has
// the person's board skip-under set to 3600 s, its longest (a setting anyone can choose), so each test keeps
// its subject; the storyboard's own tests pass a video with footage and are left as they are.
// backend/agent-stops.test.mjs proves a graphics-only video asks the storyboard.
import * as stops from "./agent/stops.mjs";

export const BOARD_SKIP_UNDER = 3600;

/** On a test server: sets the person's board skip-under (dashboard settings); 8 puts back the default. */
export async function skipBoardOn(server, under = BOARD_SKIP_UNDER) {
  const headers = { "sec-fetch-site": "same-origin", origin: server.baseUrl };
  const { key } = await (await server.api("/api/dashboard/review-key", { method: "POST", headers })).json();
  const response = await server.api("/api/dashboard/settings", { method: "PUT", body: { limits: { skipBoardUnder: under } }, headers: { "x-kino-review": key } });
  if (response.status !== 200) throw new Error(`settings answered ${response.status}`);
}

/** For a service made in a test (createAgentService deps.approvals): every request allowed, the board skipped. */
export const SKIP_BOARD_APPROVALS = Object.freeze({ request: async () => ({ status: "allowed" }), limits: () => ({ skipBoardUnder: BOARD_SKIP_UNDER }) });

// The rules with the board skipped, for a video with no footage; else the rules as given.
export function rulesFor(video, rules = stops.DEFAULT_STOP_RULES) {
  if (!video || video.footage) return rules;
  return { ...rules, skipUnder: { ...rules.skipUnder, board: BOARD_SKIP_UNDER } };
}

const withRules = (options = {}) => ({ ...options, rules: rulesFor(options.video, options.rules) });

export const checkpointStep = (draft, options) => stops.checkpointStep(draft, withRules(options));
export const answerStep = (draft, options) => stops.answerStep(draft, withRules(options));
export const dashboardAnswerStep = (draft, options) => stops.dashboardAnswerStep(draft, withRules(options));
export const settleWaiting = (draft, options) => stops.settleWaiting(draft, withRules(options));
export const stopPlan = (state, video = {}, rules) => stops.stopPlan(state, video, rulesFor(video, rules));
export const openStops = (state, video = {}, rules) => stops.openStops(state, video, rulesFor(video, rules));
export const statusLines = (state, video = {}, rules) => stops.statusLines(state, video, rulesFor(video, rules));
export const statusMove = (state, video = {}, rules) => stops.statusMove(state, video, rulesFor(video, rules));
