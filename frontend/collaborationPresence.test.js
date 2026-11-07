import assert from "node:assert/strict";
import test from "node:test";
import { createPresenceChannel } from "./collaborationPresence.js";

function fakeClock() {
  let time = 0, nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { id, at: time + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(milliseconds) {
      const target = time + milliseconds;
      let steps = 0;
      while (true) {
        const next = [...timers.values()].filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!next) break;
        timers.delete(next.id);
        time = next.at;
        next.callback();
        if (++steps > 10_000) throw new Error("Fake clock exceeded its timer step limit.");
      }
      time = target;
    },
    pendingCount: () => timers.size,
  };
}

function fakeSocket(now = () => 0, onSend = null) {
  return {
    readyState: 1,
    sent: [],
    send(serialized) {
      const message = JSON.parse(serialized);
      this.sent.push({ message, at: now() });
      onSend?.(message);
    },
  };
}

function channelWithClock() {
  const clock = fakeClock();
  return { clock, channel: createPresenceChannel({ now: clock.now, setTimer: clock.setTimer.bind(clock), clearTimer: clock.clearTimer.bind(clock) }) };
}

const person = (id, sceneId = "scene-a") => ({ id, name: id, color: "#3366cc", sceneId });
const acknowledge = (channel, selfId = "self", people = [person(selfId)]) =>
  channel.receive({ type: "presence", selfId, people });
const messagesOf = (socket, type) => socket.sent.filter(({ message }) => message.type === type);

test("selection waits for presence acknowledgement and replays after selfId is set", () => {
  const { clock, channel } = channelWithClock();
  let selfIdAtSend = null;
  const socket = fakeSocket(clock.now, () => { selfIdAtSend = channel.getSnapshot().selfId; });

  channel.select("project-a", { sceneId: "scene-a", layerIds: ["new-layer"] });
  channel.connect(socket, "project-a");
  assert.equal(messagesOf(socket, "selection").length, 0);

  acknowledge(channel, "self-a");
  assert.deepEqual(messagesOf(socket, "selection").map(({ message }) => message), [
    { type: "selection", sceneId: "scene-a", layerIds: ["new-layer"] },
  ]);
  assert.equal(selfIdAtSend, "self-a", "the server's self ID is published before replay");
});

test("selection and cursor each send at most every 105ms with the latest trailing value", () => {
  const { clock, channel } = channelWithClock();
  const socket = fakeSocket(clock.now);
  channel.connect(socket, "project-a");
  acknowledge(channel);

  channel.select("project-a", { sceneId: "scene-0", layerIds: ["layer-0"] });
  channel.cursor(0, 0, "scene-0");
  for (let index = 1; index <= 25; index += 1) {
    clock.advance(20);
    channel.select("project-a", { sceneId: `scene-${index}`, layerIds: [`layer-${index}`] });
    channel.cursor(index, -index, `scene-${index}`);
  }
  clock.advance(105);

  for (const type of ["selection", "cursor"]) {
    const sent = messagesOf(socket, type);
    assert.ok(sent.length > 2, `${type} keeps sending during a sustained stream`);
    assert.ok(sent.slice(1).every((entry, index) => entry.at - sent[index].at >= 105), `${type} is rate limited`);
  }
  assert.deepEqual(messagesOf(socket, "selection").at(-1).message,
    { type: "selection", sceneId: "scene-25", layerIds: ["layer-25"] });
  assert.deepEqual(messagesOf(socket, "cursor").at(-1).message,
    { type: "cursor", x: 25, y: -25, sceneId: "scene-25" });
});

test("reconnect replays the latest own selection only to the same project", () => {
  const { channel } = channelWithClock();
  const first = fakeSocket(), sameProject = fakeSocket(), otherProject = fakeSocket();
  const original = { sceneId: "scene-a", layerIds: ["old"] };
  const latest = { sceneId: "scene-b", layerIds: ["new"] };

  channel.select("project-a", original);
  channel.connect(first, "project-a");
  acknowledge(channel);
  assert.equal(messagesOf(first, "selection").length, 1);

  channel.disconnect(first);
  channel.select("project-a", latest);
  channel.connect(sameProject, "project-a");
  assert.equal(messagesOf(sameProject, "selection").length, 0);
  acknowledge(channel, "self-again");
  assert.deepEqual(messagesOf(sameProject, "selection").map(({ message }) => message), [
    { type: "selection", sceneId: "scene-b", layerIds: ["new"] },
  ]);

  channel.disconnect(sameProject);
  channel.connect(otherProject, "project-b");
  acknowledge(channel, "self-other");
  assert.equal(messagesOf(otherProject, "selection").length, 0);
});

test("document save acknowledgement replays an unchanged selection only for its project and obeys throttling", () => {
  const { clock, channel } = channelWithClock();
  const socket = fakeSocket(clock.now);
  const selection = { sceneId: "scene-a", layerIds: ["just-created"] };
  channel.select("project-a", selection);
  channel.connect(socket, "project-a");
  acknowledge(channel);
  assert.equal(messagesOf(socket, "selection").length, 1);

  clock.advance(10);
  channel.documentSaved("project-b");
  channel.documentSaved("project-a");
  assert.equal(messagesOf(socket, "selection").length, 1, "save replay stays under the normal send limit");
  clock.advance(94);
  assert.equal(messagesOf(socket, "selection").length, 1);
  clock.advance(1);
  assert.deepEqual(messagesOf(socket, "selection").map(({ message }) => message), [
    { type: "selection", sceneId: "scene-a", layerIds: ["just-created"] },
    { type: "selection", sceneId: "scene-a", layerIds: ["just-created"] },
  ]);
});

test("a stale old-socket disconnect cannot clear a newer connection", () => {
  const { channel } = channelWithClock();
  const oldSocket = fakeSocket(), newSocket = fakeSocket();
  channel.connect(oldSocket, "project-a");
  acknowledge(channel, "self-old");

  channel.connect(newSocket, "project-a");
  const peer = person("peer");
  acknowledge(channel, "self-new", [person("self-new"), peer]);
  channel.receive({ type: "selection", id: "peer", sceneId: "scene-a", layerIds: ["shape"] });
  channel.disconnect(oldSocket);

  assert.equal(channel.getSnapshot().selfId, "self-new");
  assert.deepEqual(channel.getSnapshot().people, [person("self-new"), peer]);
  assert.deepEqual(channel.getSnapshot().selections.peer.layerIds, ["shape"]);
});

test("roster changes remove departed peers and stale cross-scene cursors and selections", () => {
  const { channel } = channelWithClock();
  const socket = fakeSocket();
  const peer = person("peer", "scene-a"), departed = person("departed", "scene-a");
  channel.connect(socket, "project-a");
  acknowledge(channel, "self", [person("self"), peer, departed]);
  for (const id of ["peer", "departed"]) {
    channel.receive({ type: "cursor", id, x: 10, y: 20, sceneId: "scene-a" });
    channel.receive({ type: "selection", id, sceneId: "scene-a", layerIds: [`${id}-layer`] });
  }
  assert.deepEqual(Object.keys(channel.getSnapshot().cursors).sort(), ["departed", "peer"]);
  assert.deepEqual(Object.keys(channel.getSnapshot().selections).sort(), ["departed", "peer"]);

  acknowledge(channel, "self", [person("self"), person("peer", "scene-b")]);
  assert.deepEqual(channel.getSnapshot().cursors, {});
  assert.deepEqual(channel.getSnapshot().selections, {});
});

test("a delayed cursor from a peer's previous scene cannot return after the roster switches", () => {
  const { channel } = channelWithClock();
  const socket = fakeSocket();
  channel.connect(socket, "project-a");
  acknowledge(channel, "self", [person("self"), person("peer", "scene-a")]);
  channel.receive({ type: "cursor", id: "peer", x: 1, y: 2, sceneId: "scene-a" });
  assert.equal(channel.getSnapshot().cursors.peer.sceneId, "scene-a");

  acknowledge(channel, "self", [person("self"), person("peer", "scene-b")]);
  assert.deepEqual(channel.getSnapshot().cursors, {});
  const afterRosterSwitch = channel.getSnapshot();
  channel.receive({ type: "cursor", id: "peer", x: 3, y: 4, sceneId: "scene-a" });
  assert.strictEqual(channel.getSnapshot(), afterRosterSwitch, "stale scene traffic leaves the snapshot unchanged");
  assert.deepEqual(channel.getSnapshot().cursors, {});

  channel.receive({ type: "cursor", id: "peer", x: 5, y: 6, sceneId: "scene-b" });
  assert.equal(channel.getSnapshot().cursors.peer.sceneId, "scene-b");
  assert.equal(channel.getSnapshot().cursors.peer.x, 5);
});

test("heartbeat pings recur every 15 seconds", () => {
  const { clock, channel } = channelWithClock();
  const socket = fakeSocket(clock.now);
  channel.connect(socket, "project-a");
  acknowledge(channel);

  clock.advance(14_999);
  assert.equal(messagesOf(socket, "ping").length, 0);
  clock.advance(1);
  assert.equal(messagesOf(socket, "ping").length, 1);
  clock.advance(15_000);
  assert.equal(messagesOf(socket, "ping").length, 2);
});

test("remote cursors become idle after ten seconds and movement revives them", () => {
  const { clock, channel } = channelWithClock();
  const socket = fakeSocket();
  channel.connect(socket, "project-a");
  acknowledge(channel, "self", [person("self"), person("peer")]);
  const move = (x) => channel.receive({ type: "cursor", id: "peer", x, y: 5, sceneId: "scene-a" });

  move(1);
  assert.equal(channel.getSnapshot().cursors.peer.idle, false);
  clock.advance(9_999);
  assert.equal(channel.getSnapshot().cursors.peer.idle, false);
  clock.advance(1);
  assert.equal(channel.getSnapshot().cursors.peer.idle, true);

  move(2);
  assert.equal(channel.getSnapshot().cursors.peer.idle, false);
  assert.equal(channel.getSnapshot().cursors.peer.x, 2);
  clock.advance(10_000);
  assert.equal(channel.getSnapshot().cursors.peer.idle, true);
});

test("disconnect clears timers and remote presence state", () => {
  const { clock, channel } = channelWithClock();
  const socket = fakeSocket(clock.now);
  channel.connect(socket, "project-a");
  acknowledge(channel, "self", [person("self"), person("peer")]);
  channel.receive({ type: "cursor", id: "peer", x: 1, y: 2, sceneId: "scene-a" });
  channel.receive({ type: "selection", id: "peer", sceneId: "scene-a", layerIds: ["shape"] });
  channel.select("project-a", { sceneId: "scene-a", layerIds: ["first"] });
  channel.cursor(1, 2, "scene-a");
  clock.advance(20);
  channel.select("project-a", { sceneId: "scene-a", layerIds: ["latest"] });
  channel.cursor(3, 4, "scene-a");
  assert.ok(clock.pendingCount() >= 4, "heartbeat, cursor expiry, and trailing sends are scheduled");
  const sentBeforeDisconnect = socket.sent.length;

  channel.disconnect(socket);
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(channel.getSnapshot(), { selfId: null, people: [], cursors: {}, selections: {} });
  clock.advance(60_000);
  assert.equal(socket.sent.length, sentBeforeDisconnect, "cleared timers do not send after disconnect");
});

test("presence sends only ephemeral messages and roster identity survives pointer updates", () => {
  const { clock, channel } = channelWithClock();
  const socket = fakeSocket(clock.now);
  channel.connect(socket, "project-a");
  acknowledge(channel, "self", [person("self"), person("peer")]);
  const roster = channel.getRoster();

  channel.cursor(4, 5, "scene-a");
  channel.select("project-a", { sceneId: "scene-a", layerIds: ["shape"] });
  channel.receive({ type: "cursor", id: "peer", x: 6, y: 7, sceneId: "scene-a" });
  channel.receive({ type: "selection", id: "peer", sceneId: "scene-a", layerIds: ["shape"] });
  clock.advance(10_000);

  assert.strictEqual(channel.getRoster(), roster, "cursor and selection traffic does not replace the roster snapshot");
  assert.deepEqual(socket.sent.map(({ message }) => message.type), ["cursor", "selection"]);
  assert.ok(socket.sent.every(({ message }) => !Object.hasOwn(message, "document") && !Object.hasOwn(message, "revision")));
});

test("pre-load null project selection and save acknowledgements are inert", () => {
  const { clock, channel } = channelWithClock();
  const initialSnapshot = channel.getSnapshot();
  const initialRoster = channel.getRoster();

  assert.doesNotThrow(() => {
    channel.select(undefined, null);
    channel.select(null, null);
    channel.select("", null);
    channel.documentSaved(undefined);
    channel.documentSaved(null);
  });
  assert.strictEqual(channel.getSnapshot(), initialSnapshot);
  assert.strictEqual(channel.getRoster(), initialRoster);
  assert.equal(clock.pendingCount(), 0);

  const socket = fakeSocket(clock.now);
  channel.connect(socket, "project-a");
  acknowledge(channel);
  assert.equal(messagesOf(socket, "selection").length, 0, "an empty project selection was not retained for replay");
});

test("scene snapshots stay memoized off-scene while preserving geometry inputs and following roster changes", () => {
  const { channel } = channelWithClock();
  const socket = fakeSocket();
  const people = [person("self", "scene-a"), person("peer-a", "scene-a"), person("peer-b", "scene-b")];
  channel.connect(socket, "project-a");
  acknowledge(channel, "self", people);
  channel.receive({ type: "selection", id: "peer-a", sceneId: "scene-a", layerIds: ["shape-a"] });

  const beforeA = channel.getSceneSnapshot("scene-a");
  const beforeB = channel.getSceneSnapshot("scene-b");
  assert.strictEqual(channel.getSceneSnapshot("scene-a"), beforeA);
  assert.strictEqual(channel.getSceneSnapshot("scene-b"), beforeB);
  const selectionGeometry = beforeA.selections;

  channel.receive({ type: "cursor", id: "peer-a", x: 10, y: 20, sceneId: "scene-a" });
  const afterCursorA = channel.getSceneSnapshot("scene-a");
  assert.notStrictEqual(afterCursorA, beforeA, "a cursor in the scene changes its snapshot");
  assert.notStrictEqual(afterCursorA.cursors, beforeA.cursors);
  assert.strictEqual(afterCursorA.selections, selectionGeometry, "cursor movement preserves selection geometry inputs");
  assert.strictEqual(channel.getSceneSnapshot("scene-a"), afterCursorA, "unchanged scene reads reuse their object");
  assert.strictEqual(channel.getSceneSnapshot("scene-b"), beforeB, "a cursor in scene A does not invalidate scene B");

  const renamedPeople = [people[0], { ...people[1], name: "Peer A renamed" }, people[2]];
  channel.receive({ type: "presence", selfId: "self", people: renamedPeople });
  const afterRenameA = channel.getSceneSnapshot("scene-a");
  assert.notStrictEqual(afterRenameA, afterCursorA);
  assert.equal(afterRenameA.people.find((item) => item.id === "peer-a").name, "Peer A renamed");
  assert.strictEqual(channel.getSceneSnapshot("scene-b"), beforeB, "an unrelated name change preserves scene B");

  channel.disconnect(socket);
  const emptyA = channel.getSceneSnapshot("scene-a");
  const emptyB = channel.getSceneSnapshot("scene-b");
  for (const sceneSnapshot of [emptyA, emptyB]) {
    assert.deepEqual(sceneSnapshot, { people: [], cursors: {}, selections: {} });
  }
  assert.strictEqual(channel.getSceneSnapshot("scene-a"), emptyA);
  assert.strictEqual(channel.getSceneSnapshot("scene-b"), emptyB);
});
