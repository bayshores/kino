// The safe math expression language: precedence, functions, refusals, seeds, speed.
import assert from "node:assert/strict";
import test from "node:test";
import { compileExpression, EXPRESSION_FUNCTIONS, ExpressionError } from "./expression.js";

const INPUTS = ["u", "v", "t", "seed", "a", "b", "c"];
const run = (source, values = {}, seed = 0) => compileExpression(source, { inputs: INPUTS, seed }).evaluate(values);
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

test("precedence and associativity", () => {
  const cases = {
    "1 + 2 * 3": 7,
    "(1 + 2) * 3": 9,
    "2 ^ 3 ^ 2": 512,
    "-2 ^ 2": -4,
    "2 ^ -1": 0.5,
    "10 - 4 - 3": 3,
    "12 / 3 / 2": 2,
    "7 % 3": 1,
    "-1 % 3": 2,
    "1 + 2 < 4": 1,
    "2 * 3 >= 7": 0,
    "1 == 1": 1,
    "1 != 1": 0,
    "1 < 2 == 1": 1,
    "--3": 3,
    "+.5e1": 5,
    "1 / 0": 0,
    "pi": Math.PI,
    "tau / 2": Math.PI,
  };
  for (const [source, expected] of Object.entries(cases)) close(run(source), expected, source);
  close(run("u * 2 + v", { u: 3, v: 1 }), 7, "inputs");
  close(run("a"), 0, "missing input reads 0");
  assert.equal(compileExpression("1 + 2").constant, true);
  assert.equal(compileExpression("u", { inputs: ["u"] }).run([4]), 4);
});

test("every function", () => {
  const cases = {
    "sin(1)": Math.sin(1), "cos(1)": Math.cos(1), "tan(1)": Math.tan(1),
    "abs(-2)": 2, "floor(-1.5)": -2, "ceil(1.2)": 2, "fract(-1.25)": 0.75,
    "min(3, 1, 2)": 1, "max(3, 1, 2)": 3, "clamp(5, 0, 1)": 1, "clamp(-5, 0, 1)": 0,
    "mix(2, 4, 0.25)": 2.5, "step(0.5, 0.4)": 0, "step(0.5, 0.5)": 1,
    "smoothstep(0, 1, 0.5)": 0.5, "smoothstep(0, 1, 2)": 1, "smoothstep(0, 1, 0.25)": 0.15625,
    "sqrt(9)": 3, "pow(2, 10)": 1024, "exp(1)": Math.E, "log(exp(2))": 2,
    "length(3, 4)": 5, "length(-2)": 2, "length(1, 2, 2)": 3, "atan2(1, 1)": Math.PI / 4,
  };
  const tested = new Set(["hash", "noise"]);
  for (const [source, expected] of Object.entries(cases)) {
    close(run(source), expected, source);
    tested.add(source.slice(0, source.indexOf("(")));
  }
  assert.deepEqual([...tested].sort(), [...EXPRESSION_FUNCTIONS]);

  for (const source of ["hash(u)", "hash(u, v, t, a)", "noise(u * 9, v * 9)", "noise(u * 9, v * 9, t)"]) {
    for (let i = 0; i < 200; i += 1) {
      const value = run(source, { u: i * 0.37, v: i * 0.11, t: i * 0.05, a: i });
      assert.ok(value >= 0 && value <= 1, `${source} in 0..1: ${value}`);
    }
  }
  assert.notEqual(run("hash(1)"), run("hash(2)"));
  assert.equal(run("hash(0)"), run("hash(-0)"));
  // Value noise is smooth: a tiny step moves it a tiny amount, and it hits the lattice values.
  const near = Math.abs(run("noise(u, 0.3)", { u: 1.5 }) - run("noise(u, 0.3)", { u: 1.5001 }));
  assert.ok(near < 0.01, `noise smooth: ${near}`);
  const lattice = new Set([0, 1, 2, 3, 4].map((i) => run("noise(u, 2)", { u: i })));
  assert.ok(lattice.size > 3, "noise varies between lattice points");
});

test("refuses everything outside the language", () => {
  const refused = {
    "constructor": /unknown name "constructor".*functions abs, atan2/,
    "process": /unknown name "process"/,
    "process.exit(1)": /property access/,
    "globalThis": /unknown name "globalThis"/,
    "this": /unknown name "this"/,
    "__proto__": /unknown name "__proto__"/,
    "u.constructor": /property access/,
    "'abc'": /strings are not allowed/,
    "\"abc\"": /strings are not allowed/,
    "`abc`": /strings are not allowed/,
    "u[0]": /brackets/,
    "{}": /brackets/,
    "constructor(1)": /"constructor" is not a function/,
    "toString(1)": /"toString" is not a function/,
    "u(1)": /"u" is not a function/,
    "sin": /sin is a function/,
    "sin(1, 2)": /sin takes 1 values, got 2/,
    "noise(1)": /noise takes 2 to 3 values/,
    "2u": /write 2 \* u/,
    "u = 1": /"=" is not allowed/,
    "u; 1": /";" is not allowed/,
    "1 +": /expected a number/,
    "(1": /expected "\)"/,
    "1 2": /expected an operator/,
    "": /empty/,
    [`${"(".repeat(80)}1${")".repeat(80)}`]: /nested deeper/,
  };
  for (const [source, pattern] of Object.entries(refused)) {
    assert.throws(() => compileExpression(source, { inputs: INPUTS }), (error) => error instanceof ExpressionError && pattern.test(error.message), source);
  }
  assert.throws(() => compileExpression("1", { inputs: ["sin"] }), /taken by a function/);
  assert.throws(() => compileExpression("1", { inputs: ["a.b"] }), /letters, digits/);
});

test("same seed and inputs give the same value; seeds differ", () => {
  const values = { u: 0.3, v: 0.7, t: 1.2, a: 4 };
  for (const source of ["hash(u, v, a)", "noise(u * 7, v * 7, t)"]) {
    assert.equal(run(source, values, 5), run(source, values, 5));
    assert.equal(compileExpression(source, { inputs: INPUTS, seed: 5 }).evaluate(values), run(source, values, 5));
    assert.notEqual(run(source, values, 5), run(source, values, 6));
  }
});

test("256 x 256 points evaluate in under 30 ms", () => {
  const field = compileExpression(
    "mix(smoothstep(0.2, 0.21, length(u - 0.5, v - 0.5)), noise(u * 8, v * 8, t), a) + sin(u * tau * 4 + t) * b",
    { inputs: INPUTS, seed: 3 },
  );
  const env = new Float64Array(INPUTS.length);
  env[2] = 0.4; env[4] = 0.5; env[5] = 0.1;
  const pass = () => {
    let sum = 0;
    const started = performance.now();
    for (let y = 0; y < 256; y += 1) {
      env[1] = y / 255;
      for (let x = 0; x < 256; x += 1) {
        env[0] = x / 255;
        sum += field.run(env);
      }
    }
    return { ms: performance.now() - started, sum };
  };
  pass(); // warm up
  const best = Math.min(pass().ms, pass().ms, pass().ms);
  console.log(`expression: 256x256 points in ${best.toFixed(2)} ms`);
  assert.ok(best < 30, `took ${best} ms`);
});
