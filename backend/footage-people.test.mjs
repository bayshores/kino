import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPeopleCache } from "./footage/people.mjs";

test("a clip that failed is not measured again for ten minutes; a cancelled one is", async () => {
  let tries = 0;
  let clock = 0;
  const cache = createPeopleCache({ now: () => clock, measure: async () => { tries += 1; throw new Error("FFmpeg could not decode the video: broken"); } });
  const file = path.join(tmpdir(), "kino-people-never-written.mp4");
  await assert.rejects(cache.get(file, {}), /could not decode/);
  await assert.rejects(cache.get(file, {}), /could not decode/);
  assert.equal(tries, 1);
  clock = 11 * 60_000;
  await assert.rejects(cache.get(file, {}));
  assert.equal(tries, 2);

  let cancels = 0;
  const cancelled = createPeopleCache({ measure: async () => { cancels += 1; throw Object.assign(new Error("cancelled"), { name: "AbortError" }); } });
  await assert.rejects(cancelled.get(file, {}));
  await assert.rejects(cancelled.get(file, {}));
  assert.equal(cancels, 2);
});

test("a helper that stopped on a clip is remembered; a computer without the helper is not", async () => {
  let tries = 0;
  const stopped = createPeopleCache({ measure: async () => { tries += 1; return { version: 1, unavailable: "the kino-measure helper stopped: crash" }; } });
  const file = path.join(tmpdir(), "kino-people-never-written-2.mp4");
  await stopped.get(file, {});
  assert.match((await stopped.get(file, {})).unavailable, /helper stopped/);
  assert.equal(tries, 1);

  let asks = 0;
  const none = createPeopleCache({ measure: async () => { asks += 1; return { version: 1, unavailable: "finding people needs macOS 12 or later" }; } });
  await none.get(file, {});
  await none.get(file, {});
  assert.equal(asks, 2);
});
