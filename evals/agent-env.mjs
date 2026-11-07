// How evals/run.mjs starts an agent in isolation: new, empty temporary folders (work, HOME,
// CLAUDE_CONFIG_DIR, CODEX_HOME, TMPDIR) outside any Git repository, and an environment built
// from nothing. The only login it carries is one API key: ANTHROPIC_API_KEY for Claude,
// CODEX_API_KEY for Codex. With HOME, CLAUDE_CONFIG_DIR and CODEX_HOME pointing at empty
// folders, neither CLI can find the operator's own login (Claude Code keys its macOS Keychain
// entry to CLAUDE_CONFIG_DIR; Codex keeps its login in CODEX_HOME).
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const API_KEY_VARIABLES = Object.freeze({ claude: "ANTHROPIC_API_KEY", codex: "CODEX_API_KEY" });

// Variables copied from the operator's environment because programs misbehave without them.
// None of them is a secret or points at the operator's own configuration.
const PASS_THROUGH = Object.freeze(["PATH", "USER", "LOGNAME"]);

/**
 * The environment for one agent process, built from nothing.
 * - `agent`: "claude" or "codex".
 * - `dirs`: { homeDir, claudeConfigDir, codexHome, tmpDir } (from makeTrialDirs).
 * - `source`: where PATH and the API key are read from (normally process.env).
 */
export function isolatedEnv({ agent, dirs, source = process.env }) {
  const env = {};
  for (const name of PASS_THROUGH) if (source[name]) env[name] = source[name];
  Object.assign(env, {
    HOME: dirs.homeDir,
    TMPDIR: dirs.tmpDir,
    CLAUDE_CONFIG_DIR: dirs.claudeConfigDir,
    CODEX_HOME: dirs.codexHome,
    SHELL: "/bin/bash",
    LANG: "en_US.UTF-8",
    // Claude Code: no auto memory, a pinned prompt-cache lifetime, no self-update, no
    // telemetry or error reports (https://code.claude.com/docs/en/env-vars).
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
  const keyName = API_KEY_VARIABLES[agent];
  if (keyName && source[keyName]) env[keyName] = source[keyName];
  return env;
}

// True when `folder` is inside a Git repository (it or a parent holds .git).
function insideGitRepository(folder) {
  let current = path.resolve(folder);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * New, empty folders for one run, under `tempRoot` (default: the system temp folder).
 * Layout:  <trialDir>/work  home  claude-config  codex-home  tmp
 */
export async function makeTrialDirs({ tempRoot = tmpdir(), label = "run" } = {}) {
  await mkdir(tempRoot, { recursive: true });
  const trialDir = await mkdtemp(path.join(tempRoot, `kino-eval-${label.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 60)}-`));
  const dirs = {
    trialDir,
    workDir: path.join(trialDir, "work"),
    homeDir: path.join(trialDir, "home"),
    claudeConfigDir: path.join(trialDir, "claude-config"),
    codexHome: path.join(trialDir, "codex-home"),
    tmpDir: path.join(trialDir, "tmp"),
  };
  for (const folder of Object.values(dirs)) await mkdir(folder, { recursive: true });
  if (insideGitRepository(dirs.workDir))
    throw new Error(`The work folder ${dirs.workDir} is inside a Git repository. Put run folders somewhere else.`);
  return dirs;
}
