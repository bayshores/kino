import test from "node:test";
import assert from "node:assert/strict";
import { appMenuTemplate } from "../desktop/menu.mjs";

function menu(packaged = true) {
  const calls = [];
  const template = appMenuTemplate({
    packaged,
    editCommand: (window, command) => calls.push(["edit", window.id, command]),
    reload: (window) => calls.push(["reload", window.id]),
    restartService: () => calls.push(["restart"]),
    openBundledFolder: (name) => calls.push(["open", name]),
  });
  const find = (label) => template.flatMap(top => [top, ...(top.submenu || [])]).find(item => item.label === label);
  return { template, calls, find };
}

test("the menu bar has kino, File, Edit, View, Window and Help, in the usual Mac order", () => {
  const { template } = menu();
  assert.deepEqual(template.map(top => top.label || top.role), ["kino", "fileMenu", "Edit", "View", "windowMenu", "help"]);
  // On a Mac, Electron's "fileMenu" is File > Close Window (⌘W).
  assert.deepEqual(template[1], { role: "fileMenu" });
  assert.deepEqual(template[0].submenu.filter(item => item.role).map(item => item.role), ["about", "hide", "hideOthers", "unhide", "quit"]);
});

test("custom items send their work to the window they were chosen in", () => {
  const { find, calls } = menu();
  const window = { id: 7 };
  find("Undo").click(null, window);
  find("Redo").click(null, window);
  find("Reload").click(null, window);
  find("Restart local service").click(null, window);
  find("Bundled media licenses").click();
  find("Bundled media source").click();
  // With no window in front (all closed), Undo, Redo and Reload do nothing.
  find("Undo").click(null, undefined);
  find("Reload").click(null, undefined);
  assert.deepEqual(calls, [["edit", 7, "undo"], ["edit", 7, "redo"], ["reload", 7], ["restart"], ["open", "licenses"], ["open", "sources"]]);
  assert.equal(find("Undo").accelerator, "CmdOrCtrl+Z");
  assert.equal(find("Redo").accelerator, "CmdOrCtrl+Shift+Z");
  assert.equal(find("Reload").accelerator, "CmdOrCtrl+Shift+R");
});

test("developer tools are in the View menu only when kino runs from source", () => {
  const roles = (packaged) => menu(packaged).template.find(top => top.label === "View").submenu.map(item => item.role).filter(Boolean);
  assert.deepEqual(roles(true), ["togglefullscreen"]);
  assert.deepEqual(roles(false), ["togglefullscreen", "toggleDevTools"]);
});
