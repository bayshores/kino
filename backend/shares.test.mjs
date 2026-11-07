import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { accessFor, hideShareSecrets, openShareStore } from "./shares.mjs";

test("share links persist only a secret hash and survive reopening", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-shares-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const firstStore = await openShareStore(directory);
  const { grant, token } = await firstStore.create("project-one", {
    role: "comment",
    label: "  Reviewers  ",
  });
  assert.equal(grant.projectId, "project-one");
  assert.equal(grant.role, "comment");
  assert.equal(grant.label, "Reviewers");
  assert.equal("token" in grant, false);
  assert.equal("tokenHash" in grant, false);

  const filename = path.join(directory, "shares.json");
  const storedText = await readFile(filename, "utf8");
  const stored = JSON.parse(storedText);
  assert.equal(storedText.includes(token), false, "the bearer secret is never written to disk");
  assert.match(stored.grants[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);

  const reopenedStore = await openShareStore(directory);
  assert.deepEqual(await reopenedStore.authorize(token), grant);
  assert.deepEqual(await reopenedStore.list("project-one"), [grant]);
  assert.equal((await reopenedStore.list("other-project")).length, 0);

  const revoked = await reopenedStore.revoke("project-one", grant.id);
  assert.ok(revoked.grant.revokedAt);
  assert.equal("tokenHash" in revoked.grant, false);
  assert.equal(await reopenedStore.authorize(token), null);
});

test("malformed, altered, and unknown link secrets never authorize", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-shares-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const shares = await openShareStore(directory);
  const { token } = await shares.create("project-one", { role: "view" });
  const [id, secret] = token.split(".");
  const changedToken = `${id}.${secret[0] === "A" ? "B" : "A"}${secret.slice(1)}`;

  for (const invalid of [
    "",
    "not-a-token",
    `${id}.short`,
    `${id}.!${secret.slice(1)}`,
    `${id}.${"A".repeat(43)}`,
    `${"0".repeat(36)}.${secret}`,
    changedToken,
    null,
    42,
  ]) {
    assert.equal(await shares.authorize(invalid), null, `rejected malformed token ${String(invalid)}`);
  }
});

test("anonymous link roles expose only their intended capabilities", () => {
  assert.deepEqual(accessFor(), {
    role: "owner",
    canEdit: true,
    canComment: true,
    canExport: true,
    manageShares: true,
  });
  assert.deepEqual(accessFor("view"), {
    role: "view",
    canEdit: false,
    canComment: false,
    canExport: true,
    manageShares: false,
  });
  assert.deepEqual(accessFor("comment"), {
    role: "comment",
    canEdit: false,
    canComment: true,
    canExport: true,
    manageShares: false,
  });
  assert.deepEqual(accessFor("edit"), {
    role: "edit",
    canEdit: true,
    canComment: true,
    canExport: true,
    manageShares: false,
  });
});

test("text for logs and screens loses every link secret, even one cut short", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-shares-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { grant, token } = await (await openShareStore(directory)).create("project-one", { role: "comment" });
  const secret = token.split(".")[1];
  const url = `http://127.0.0.1:4821/?project=project-one#share=${token}`;
  const cases = [
    `comment link to project-one: ${url} (anyone with it can comment)`,
    JSON.stringify({ result: `comment link: ${url}`, url, desktopUrl: `kino://open?project=project-one#share=${token}` }),
    JSON.stringify({ grant, token }),
    `cut short: ${url}`.slice(0, 80),
    `cut short: ${token}`.slice(0, 60),
    // An activity-log input is cut at 600 characters and ends with "…".
    `${JSON.stringify({ token })}`.slice(0, 60) + "…",
    `/api/media/clip.mp4?share=${token}`,
    `#scene=s1&share=${token}`,
    `${token}. Send it to the client.`,
  ];
  for (const text of cases) {
    const hidden = hideShareSecrets(text);
    assert.equal(hidden.includes(secret.slice(0, 8)), false, hidden);
    assert.doesNotMatch(hidden, /#share=(?!\(secret omitted\))/, hidden);
  }
  assert.equal(hideShareSecrets(`see ${url} now`), "see http://127.0.0.1:4821/?project=project-one#share=(secret omitted) now");
  assert.equal(hideShareSecrets(`${token}. Send it`), "(secret omitted). Send it");
  assert.equal(hideShareSecrets(`#share=`), "#share=(secret omitted)", "every #share= is hidden, even an empty one");
  assert.equal(hideShareSecrets(undefined), "");
});

test("hiding share secrets leaves ordinary text alone: ids, file names, paths and URLs without a link secret", () => {
  const id = "32f971ff-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  const other = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const ordinary = [
    `revoke id:"${id}"`,
    `${id}.json`,
    `${id}.thumbnail.png`,
    `${id}.events.jsonl`,
    `/api/media/${id}.png`,
    // A real model error (engine/model.js), shown in the activity log.
    `{"error":"failed","reason":"layer.${id}.componentSceneId: must reference a main component scene"}`,
    `layer.${id}.componentSceneId must reference a main component scene`,
    `${"ab12".repeat(16)}.segment-cache`,
    `?project=dash&scene=${id}&layer=${other}`,
    `componentPath "${id}/${other}"`,
    `${id}.${other}.json`,
    // Not a token: 44 characters after the dot.
    `${id}.${"A".repeat(44)}`,
    "the #share part of a link",
  ];
  for (const text of ordinary) assert.equal(hideShareSecrets(text), text);
});
