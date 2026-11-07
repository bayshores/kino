// One shared limit on how many GIFs this server process decodes at the same time.
// Decoding a large GIF uses a lot of memory and CPU, so the editor's frame cache
// (gif-frame-cache.mjs) and exports (export.mjs) wait for the same few slots.

const DEFAULT_SLOTS = 2;

/**
 * Creates a slot limit. `run(task)` starts `task` when fewer than `slots` tasks are running;
 * otherwise it waits its turn (oldest first). A task that is cancelled while waiting
 * (its `signal` aborts) leaves the queue without ever running.
 */
export function createDecodeSlots(slots = DEFAULT_SLOTS) {
  let running = 0;
  // Each waiting entry is { start, cancel } for a task waiting for a free slot.
  const waiting = [];

  function release() {
    const next = waiting.shift();
    // A finishing task hands its slot straight to the next waiting one.
    if (next) next.start();
    else running -= 1;
  }

  async function run(task, { signal } = {}) {
    signal?.throwIfAborted();
    if (running < slots) running += 1;
    else {
      await new Promise((resolve, reject) => {
        const entry = {
          start: () => {
            signal?.removeEventListener("abort", entry.cancel);
            resolve();
          },
          cancel: () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
            reject(signal.reason ?? new Error("Media processing was cancelled."));
          },
        };
        signal?.addEventListener("abort", entry.cancel, { once: true });
        waiting.push(entry);
      });
    }
    try {
      return await task();
    } finally {
      release();
    }
  }

  return { run };
}

/** The process-wide limit shared by the GIF frame cache and exports. */
export const gifDecodeSlots = createDecodeSlots();
