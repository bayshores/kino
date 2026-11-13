// The sentence that brings an agent back to a project. The dashboard copies it for the person to
// paste into their agent's chat, and kino sends it itself when it continues the agent's session
// (backend/agent/resume.mjs), so both say the same thing.

/** "Continue the kino project "Promo" (p1): call kino status first." */
export function continuePrompt(projectName, projectId) {
  const name = String(projectName ?? "").trim();
  return `Continue the kino project ${name ? `"${name}" (${projectId})` : projectId}: call kino status first.`;
}
