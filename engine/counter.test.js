// The Counter operation (counter.js): its defaults, its checks and the values it counts through.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COUNTER_STEPS,
  MAX_COUNTER_VALUE,
  counterEditProblem,
  counterFormatOf,
  counterIndexAt,
  counterLayerProblem,
  counterPlaybackLength,
  counterSteps,
  counterTextAt,
  counterValueAt,
  counterValueProblem,
  createCounter,
  defaultCounterTo,
} from "./counter.js";

const textLayer = (text) => ({ id: "t", type: "text", text, fontSize: 48, animations: [] });
const counter = (fields) => ({ id: "c", name: "Counter", kind: "counter", start: 0, duration: 1, easing: "linear", from: 0, to: 10, step: 1, out: null, in: null, ...fields });

// Every value a Counter counts through, in its text format.
function texts(layer, item) {
  const steps = counterSteps(item);
  const format = counterFormatOf(layer, item);
  return Array.from({ length: steps.count + 1 }, (_, index) => counterTextAt(item, format, index, steps));
}

test("a new Counter counts from the number in the text to 100 more", () => {
  const created = createCounter(textLayer("Score: 42"), 0.5, "id-1");
  assert.deepEqual(created, {
    id: "id-1", name: "Counter", kind: "counter", start: 0.5, duration: 1, easing: "smooth", from: 42, to: 142, step: 1, out: null, in: null,
  });
  assert.equal(createCounter(textLayer("-1,234.5%"), 0, "c").from, -1234.5);
  // Near the largest value it counts down instead, so To is still a different number.
  assert.equal(defaultCounterTo(MAX_COUNTER_VALUE), MAX_COUNTER_VALUE - 100);
  assert.equal(createCounter(textLayer("9".repeat(20)), 0, "c").from, MAX_COUNTER_VALUE);
});

test("a text without a number or a layer that isn't text is refused with a reason", () => {
  assert.throws(() => createCounter(textLayer("Hello"), 0, "c"), { name: "RangeError", message: /needs a number in the text.*“Hello” has no digits/u });
  assert.throws(() => createCounter({ id: "r", type: "rectangle", animations: [] }, 0, "c"), /needs a text layer/u);
  assert.throws(() => createCounter(textLayer("1"), -1, "c"), /start time/u);
  assert.match(counterLayerProblem(textLayer(""), counter()), /“” has no digits/u);
  assert.equal(counterLayerProblem(textLayer("1"), counter()), "");
  // Only a new Counter is refused; an existing one can still be edited after the text lost its number.
  assert.match(counterEditProblem(textLayer("none"), null, counter()), /no digits/u);
  assert.match(counterEditProblem(textLayer("none"), { kind: "move" }, counter()), /no digits/u);
  assert.equal(counterEditProblem(textLayer("none"), counter(), counter({ to: 5 })), "");
});

test("From, To and Step must be numbers in range", () => {
  assert.equal(counterValueProblem({ from: 0, to: 10, step: 1 }), "");
  assert.match(counterValueProblem({ from: "0", to: 10, step: 1 }), /From must be a number/u);
  assert.match(counterValueProblem({ from: 0, to: Infinity, step: 1 }), /To must be a number/u);
  assert.match(counterValueProblem({ from: 0, to: 2e12, step: 1 }), /To must be from/u);
  assert.match(counterValueProblem({ from: 0, to: 10, step: 2e12 }), /Step must be at most/u);
  assert.match(counterValueProblem({ from: 0, to: 10, step: 0 }), /Step must be at least/u);
  assert.match(counterValueProblem({ from: 0, to: 10, step: -1 }), /never negative/u);
  assert.match(counterValueProblem({ from: -MAX_COUNTER_VALUE, to: MAX_COUNTER_VALUE, step: 0.001 }), new RegExp(`at most ${MAX_COUNTER_STEPS} steps`, "u"));
  assert.equal(counterValueProblem({ from: -MAX_COUNTER_VALUE, to: MAX_COUNTER_VALUE, step: 0.002 }), "");
});

test("counting up, counting down and crossing zero", () => {
  assert.deepEqual(texts(textLayer("0"), counter({ from: 0, to: 5 })), ["0", "1", "2", "3", "4", "5"]);
  assert.deepEqual(texts(textLayer("5"), counter({ from: 5, to: 0 })), ["5", "4", "3", "2", "1", "0"]);
  assert.deepEqual(texts(textLayer("$-2"), counter({ from: -2, to: 2 })), ["$-2", "$-1", "$0", "$1", "$2"]);
  assert.deepEqual(texts(textLayer("$2"), counter({ from: 2, to: -2 })), ["$2", "$1", "$0", "-$1", "-$2"]);
  assert.equal(counterSteps(counter({ from: 5, to: 0 })).direction, -1);
});

test("decimals come from the text, From, To and Step, whichever has the most", () => {
  assert.deepEqual(texts(textLayer("0"), counter({ from: 0, to: 0.5, step: 0.1 })), ["0.0", "0.1", "0.2", "0.3", "0.4", "0.5"]);
  assert.deepEqual(texts(textLayer("0.00%"), counter({ from: 0, to: 1, step: 0.5 })), ["0.00%", "0.50%", "1.00%"]);
  assert.equal(counterFormatOf(textLayer("1"), counter({ from: 1.125, to: 2, step: 1 })).decimals, 3);
  assert.equal(counterFormatOf(textLayer("1"), counter({ to: 2.5 })).decimals, 1);
  // 0.1 * 3 is 0.30000000000000004 in floating point; the step still lands on 0.3.
  assert.equal(counterIndexAt(counter({ from: 0, to: 1, step: 0.1 }), 0.3), 3);
});

test("a Step that doesn't divide the distance ends exactly on To", () => {
  assert.deepEqual(texts(textLayer("0"), counter({ from: 0, to: 10, step: 3 })), ["0", "3", "6", "9", "10"]);
  assert.deepEqual(texts(textLayer("10"), counter({ from: 10, to: 0, step: 4 })), ["10", "6", "2", "0"]);
  const steps = counterSteps(counter({ from: 0, to: 10, step: 3 }));
  assert.equal(steps.count, 4);
  // The value at a progress is rounded down toward From, so To shows only at the very end.
  assert.equal(counterIndexAt(counter({ from: 0, to: 10, step: 3 }), 0.99), 3);
  assert.equal(counterIndexAt(counter({ from: 0, to: 10, step: 3 }), 1), 3);
  assert.equal(counterValueAt(counter({ from: 0, to: 10, step: 3 }), 4), 10);
  // A Step larger than the distance is one step straight to To.
  assert.deepEqual(texts(textLayer("0"), counter({ from: 0, to: 2, step: 5 })), ["0", "2"]);
  // From equal to To never steps.
  assert.deepEqual(texts(textLayer("7"), counter({ from: 7, to: 7 })), ["7"]);
});

test("999 to 1000 with 0000 padding", () => {
  assert.deepEqual(texts(textLayer("0000"), counter({ from: 998, to: 1001 })), ["0998", "0999", "1000", "1001"]);
  assert.deepEqual(texts(textLayer("0000"), counter({ from: 9999, to: 10000 })), ["9999", "10000"]);
  assert.deepEqual(texts(textLayer("0000"), counter({ from: 1, to: -1 })), ["0001", "0000", "-0001"]);
});

test("huge ranges are computed directly", () => {
  const huge = counter({ from: 0, to: MAX_COUNTER_VALUE, step: 1 });
  const steps = counterSteps(huge);
  assert.equal(steps.count, MAX_COUNTER_VALUE);
  assert.equal(counterValueAt(huge, counterIndexAt(huge, 0.5, steps), steps), 5e11);
  assert.equal(counterTextAt(huge, counterFormatOf(textLayer("1,000"), huge), counterIndexAt(huge, 0.25, steps), steps), "250,000,000,000");
  // The most steps: 2e15 thousandths from -1e12 to 1e12, each one exact.
  const finest = counter({ from: -MAX_COUNTER_VALUE, to: MAX_COUNTER_VALUE, step: 0.002 });
  assert.equal(counterSteps(finest).count, MAX_COUNTER_STEPS);
  assert.equal(counterTextAt(finest, counterFormatOf(textLayer("0"), finest), counterIndexAt(finest, 0.5)), "0.000");
  assert.equal(counterTextAt(finest, counterFormatOf(textLayer("0"), finest), 1), "-999999999999.998");
  assert.equal(counterValueAt(huge, steps.count, steps), MAX_COUNTER_VALUE);
  const negative = counter({ from: MAX_COUNTER_VALUE, to: -MAX_COUNTER_VALUE, step: 2 });
  assert.equal(counterValueAt(negative, counterIndexAt(negative, 0.5)), 0);
});

test("the playback length adds the effects of the last step", () => {
  const layer = textLayer("0");
  assert.equal(counterPlaybackLength(layer, counter({ duration: 2 })), 2);
  const fade = { preset: "fade-in", duration: 0.4, easing: "linear", unit: "layer", stagger: 0, order: "forward" };
  const out = { ...fade, preset: "fade-out", duration: 0.25 };
  assert.equal(counterPlaybackLength(layer, counter({ duration: 2, in: fade, out })), 2.4);
});
