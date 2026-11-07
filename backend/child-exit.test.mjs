import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { childrenRunning, endWithService, stopChildren } from "./child-exit.mjs";

test("a remembered child is stopped with the service and forgotten when it exits", async () => {
  const child = endWithService(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
  assert.equal(childrenRunning(), 1);
  const exited = once(child, "exit");
  stopChildren();
  const [, signal] = await exited;
  assert.equal(signal, "SIGTERM");
  assert.equal(childrenRunning(), 0);
  // One that ends on its own is forgotten too.
  const quick = endWithService(spawn(process.execPath, ["-e", ""], { stdio: "ignore" }));
  await once(quick, "exit");
  assert.equal(childrenRunning(), 0);
  // A child that never started (no pid) is not kept.
  assert.equal(endWithService({ pid: undefined }).pid, undefined);
  assert.equal(childrenRunning(), 0);
});
