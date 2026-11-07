import test from "node:test";
import assert from "node:assert/strict";
import { maskSwitchedOff } from "./maskVisibility.js";
import { createLayer } from "./model.js";

const hide = (start) => ({ id: `hide-${start}`, name: "Hide", kind: "hide", start });
const show = (start) => ({ id: `show-${start}`, name: "Show", kind: "show", start });
const mask = (values = {}) => createLayer("rectangle", { id: "mask", isMask: true, ...values });

test("a mask is switched off while its eye is off or a Hide hides it", () => {
  assert.equal(maskSwitchedOff(mask(), 1), false, "a plain mask masks");
  assert.equal(maskSwitchedOff(mask({ visible: false }), 1), true, "the eye button switches it off");
  const timed = mask({ animations: [hide(1), show(2)] });
  assert.equal(maskSwitchedOff(timed, 0.5), false);
  assert.equal(maskSwitchedOff(timed, 1), true, "off from the Hide's own time");
  assert.equal(maskSwitchedOff(timed, 1.99), true);
  assert.equal(maskSwitchedOff(timed, 2), false, "back on from the Show");
  assert.equal(maskSwitchedOff(mask({ animations: [show(1)] }), 0.5), true, "a first Show keeps it off until then");
  assert.equal(maskSwitchedOff(undefined, 0), true);
});

test("the design view ignores Hide and Show, but not the eye button", () => {
  assert.equal(maskSwitchedOff(mask({ animations: [hide(0)] }), 1, true), false);
  assert.equal(maskSwitchedOff(mask({ visible: false }), 1, true), true);
});

test("a mask inside a component follows the component's clock", () => {
  // A held component range clamps the clock: after 2 s the mask stays at its 2 s state.
  const layer = mask({ animations: [hide(2.5)], playbackWindows: [{ start: 1, end: 2, hold: true, visibility: "both" }] });
  assert.equal(maskSwitchedOff(layer, 3), false, "the Hide at 2.5 s is never reached inside the range");
  const later = mask({ animations: [hide(1.5)], playbackWindows: [{ start: 1, end: 2, hold: true, visibility: "both" }] });
  assert.equal(maskSwitchedOff(later, 3), true);
  // Other reasons a layer is not drawn, such as leaving the component's range, are not a Hide.
  const outside = mask({ playbackWindows: [{ start: 1, end: 2, hold: false }] });
  assert.equal(maskSwitchedOff(outside, 3), false);
});
