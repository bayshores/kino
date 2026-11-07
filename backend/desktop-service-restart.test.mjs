import assert from "node:assert/strict";
import test from "node:test";
import { createRestartPolicy, ownerSessionCookie, relocatedEditorUrl, restartPort } from "../desktop/service-restart.mjs";

test("restart policy allows at most three claims in a rolling 120-second window", () => {
  let timestamp = 10;
  const policy = createRestartPolicy({ now: () => timestamp });
  assert.equal(policy.remaining(), 3);
  assert.equal(policy.claim(), true);
  timestamp = 20;
  assert.equal(policy.claim(), true);
  timestamp = 30;
  assert.equal(policy.claim(), true);
  assert.equal(policy.remaining(), 0);
  assert.equal(policy.claim(), false);

  timestamp = 120_029;
  assert.equal(policy.remaining(), 2, "the newest claim is one millisecond inside the window");
  timestamp = 120_030;
  assert.equal(policy.remaining(), 3, "a claim exactly 120 seconds old is pruned");
  assert.equal(policy.claim(), true);
  assert.equal(policy.remaining(), 2);
});

test("restart policy stays conservative when the injected clock moves backwards", () => {
  let timestamp = 100;
  const policy = createRestartPolicy({ now: () => timestamp, limit: 1, windowMs: 20 });
  assert.equal(policy.claim(), true);
  timestamp = 50;
  assert.equal(policy.remaining(), 0);
  assert.equal(policy.claim(), false);
  timestamp = 120;
  assert.equal(policy.remaining(), 1, "the high-water time still prunes at the exact window boundary");
  assert.equal(policy.claim(), true);
});

test("a restart the person asks for goes ahead after the automatic tries used the budget, and counts", () => {
  let timestamp = 10;
  const policy = createRestartPolicy({ now: () => timestamp });
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal(policy.claim(), true);
  assert.equal(policy.claim(), false, "a fourth automatic restart waits");
  timestamp = 20;
  assert.equal(policy.claim({ manual: true }), true, "View > Restart local service still tries");
  assert.equal(policy.claim(), false, "the automatic tries stay stopped after it");
  assert.equal(policy.remaining(), 0);
  assert.equal(createRestartPolicy({ limit: 0 }).claim({ manual: true }), true);
  timestamp = 120_015;
  assert.equal(policy.remaining(), 2, "the manual try counts in the window like the others");
});

test("a restart asked for while the service runs goes ahead when its exit claims it, after the automatic tries", () => {
  // View > Restart local service on a running service only stops it; the restart starts when the
  // service exits, through the same claim() as an unexpected exit (desktop/main.mjs).
  let timestamp = 10;
  const policy = createRestartPolicy({ now: () => timestamp });
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal(policy.claim(), true);
  assert.equal(policy.remaining(), 0, "three restarts in two minutes used the automatic tries");
  timestamp = 20;
  policy.personAsked();
  assert.equal(policy.claim(), true, "the fourth press in two minutes still restarts the service");
  assert.equal(policy.claim(), false, "only that one claim is the person's; a retry after it is automatic");
  policy.personAsked();
  policy.personAsked();
  assert.equal(policy.claim(), true, "two presses before the service exits ask for one restart");
  assert.equal(policy.claim(), false);
  timestamp = 120_015;
  assert.equal(policy.remaining(), 1, "the asked-for restarts count in the window like the others");
});

test("restart policy validates configuration and supports a zero restart budget", () => {
  assert.equal(createRestartPolicy({ limit: 0 }).claim(), false);
  assert.equal(createRestartPolicy({ limit: 0 }).remaining(), 0);
  assert.throws(() => createRestartPolicy({ limit: -1 }), /limit/);
  assert.throws(() => createRestartPolicy({ windowMs: -1 }), /window/);
});

test("restartPort keeps a valid prior port and falls back only for a busy port or invalid value", () => {
  assert.equal(restartPort(4781), 4781);
  assert.equal(restartPort(65_535), 65_535);
  assert.equal(restartPort(4781, true), 0);
  for (const invalid of [0, -1, 65_536, 1.5, "4781", null, undefined]) assert.equal(restartPort(invalid), 0);
});

test("the owner session cookie comes from the service's answer, and a failure names the kino service", () => {
  const id = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
  const answer = (status, cookie) => new Response(null, { status, headers: cookie ? { "set-cookie": cookie } : {} });
  assert.equal(ownerSessionCookie(answer(200, `kino_owner=${id}; HttpOnly; SameSite=Strict; Path=/`)), id);
  // These words reach the person in the "kino could not start" box; there is no editor any more.
  assert.throws(() => ownerSessionCookie(answer(403, `kino_owner=${id}; HttpOnly`)),
    { message: "The local kino service could not start a session." });
  for (const cookie of [null, "other=1; HttpOnly", "kino_owner=short; HttpOnly"])
    assert.throws(() => ownerSessionCookie(answer(200, cookie)), { message: "The local kino service did not return a session." }, String(cookie));
});

test("relocated editor URLs preserve path, opaque capability query, and hash across local origins", () => {
  const current = "http://127.0.0.1:4100/editor/project?project=demo&share=manufactured.opaque-token&scene=second#timeline%20end";
  assert.equal(relocatedEditorUrl(current, "http://127.0.0.1:4100", "http://127.0.0.1:4200"),
    "http://127.0.0.1:4200/editor/project?project=demo&share=manufactured.opaque-token&scene=second#timeline%20end");
});

test("relocation refuses foreign, file, credential, and non-loopback origins", () => {
  const previous = "http://127.0.0.1:4100";
  const next = "http://127.0.0.1:4200";
  for (const url of [
    "https://example.test/editor?share=made-up",
    "http://127.0.0.1:4201/editor?share=made-up",
    "file:///tmp/index.html",
    "http://user:pass@127.0.0.1:4100/editor?share=made-up",
    "http://@127.0.0.1:4100/editor?share=made-up",
    "about:blank",
    "not a url",
  ]) assert.equal(relocatedEditorUrl(url, previous, next), null, url);

  assert.equal(relocatedEditorUrl(`${previous}/editor`, "https://127.0.0.1:4100", next), null);
  assert.equal(relocatedEditorUrl(`${previous}/editor`, previous, "https://127.0.0.1:4200"), null);
  assert.equal(relocatedEditorUrl(`${previous}/editor`, previous, "http://localhost:4200"), null);
  assert.equal(relocatedEditorUrl(`${previous}/editor`, previous, "http://user@127.0.0.1:4200"), null);
});
