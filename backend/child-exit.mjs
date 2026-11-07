// Long child processes (whisper-cli, FFmpeg decodes) that must end with this service. A child
// is not stopped when its parent exits: after quitting kino, or a service restart, a whisper run
// would keep going on its own for minutes. index.mjs stops them on SIGTERM and on exit.
const running = new Set();

/** Remembers `child` until it exits. Returns it. */
export function endWithService(child) {
  if (!child?.pid || child.exitCode !== null) return child;
  running.add(child);
  const forget = () => running.delete(child);
  child.once("exit", forget);
  child.once("error", forget);
  return child;
}

/** Signals every remembered child that is still running. */
export function stopChildren(signal = "SIGTERM") {
  for (const child of running) {
    try { child.kill(signal); } catch { /* It ended already. */ }
  }
  running.clear();
}

export const childrenRunning = () => running.size;
