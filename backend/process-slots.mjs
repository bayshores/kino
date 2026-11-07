// Shared limits on how many media programs this process runs at once, so opening several projects
// (each checking its sounds and clips) queues the work instead of loading the computer.
// heavyDecode: a full decode of a file's sound or picture (beats, waveform peaks): one at a time.
// probe: a short ffprobe read of a file's streams: a few at a time.
// Wrap only the run of one program (or one pipe of programs), never work that waits for another
// slot, so a slot holder can never wait on itself.

/** A limit of `max` runs at once: `slot(work)` waits for a free run, then calls work(). */
export function createSlots(max) {
  let running = 0;
  const waiting = [];
  async function slot(work) {
    if (running >= max) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
    try { return await work(); } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }
  slot.running = () => running;
  slot.waiting = () => waiting.length;
  return slot;
}

/** One full media decode at a time in this process. */
export const heavyDecodeSlot = createSlots(1);
/** At most three ffprobe runs at once in this process. */
export const probeSlot = createSlots(3);
