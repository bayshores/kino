// A small, safe math language for effects: numbers, named inputs, + - * / ^ %,
// comparisons and a fixed list of functions. No JS eval, no property access:
// the source is tokenized and parsed here, then compiled once to closures.

const MAX_SOURCE = 4000;
const MAX_DEPTH = 64;
const MAX_INPUTS = 32;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ExpressionError extends Error {
  constructor(message, position = -1) {
    super(position >= 0 ? `${message} (at character ${position + 1})` : message);
    this.name = "ExpressionError";
    this.position = position;
  }
}

const CONSTANTS = Object.freeze(Object.assign(Object.create(null), {
  pi: Math.PI,
  tau: Math.PI * 2,
}));

// ---- seeded hash and value noise (0..1) ----

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function seedState(seed) {
  const s = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : 0;
  return mix32((Math.imul(s | 0, 0x9e3779b1) + 0x632be5ab) >>> 0);
}

function hashFloat(h, x) {
  F64[0] = x === 0 ? 0 : x; // -0 and 0 hash the same
  h = mix32((h ^ U32[0]) >>> 0);
  return mix32((h + U32[1] + 0x27d4eb2f) >>> 0);
}

const TO_UNIT = 1 / 4294967296;

function lattice(state, ix, iy, iz) {
  let h = (state ^ Math.imul(ix | 0, 0x8da6b343)) >>> 0;
  h = mix32((h + Math.imul(iy | 0, 0xd8163841)) >>> 0);
  h = mix32((h ^ Math.imul(iz | 0, 0xcb1ab31f)) >>> 0);
  return h * TO_UNIT;
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function noise2(state, x, y) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const tx = fade(x - fx);
  const ty = fade(y - fy);
  const a = lattice(state, fx, fy, 0);
  const b = lattice(state, fx + 1, fy, 0);
  const c = lattice(state, fx, fy + 1, 0);
  const d = lattice(state, fx + 1, fy + 1, 0);
  const top = a + (b - a) * tx;
  return top + (c + (d - c) * tx - top) * ty;
}

function noise3(state, x, y, z) {
  const fz = Math.floor(z);
  const tz = fade(z - fz);
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const tx = fade(x - fx);
  const ty = fade(y - fy);
  const plane = (iz) => {
    const a = lattice(state, fx, fy, iz);
    const b = lattice(state, fx + 1, fy, iz);
    const c = lattice(state, fx, fy + 1, iz);
    const d = lattice(state, fx + 1, fy + 1, iz);
    const top = a + (b - a) * tx;
    return top + (c + (d - c) * tx - top) * ty;
  };
  const near = plane(fz);
  return near + (plane(fz + 1) - near) * tz;
}

// ---- functions: [min args, max args, make(seedState) -> fn] ----

const plain = (fn) => () => fn;
const FUNCTIONS = Object.freeze(Object.assign(Object.create(null), {
  abs: [1, 1, plain(Math.abs)],
  atan2: [2, 2, plain(Math.atan2)],
  ceil: [1, 1, plain(Math.ceil)],
  clamp: [3, 3, plain((x, lo, hi) => Math.min(Math.max(x, lo), hi))],
  cos: [1, 1, plain(Math.cos)],
  exp: [1, 1, plain(Math.exp)],
  floor: [1, 1, plain(Math.floor)],
  fract: [1, 1, plain((x) => x - Math.floor(x))],
  hash: [1, 4, (state) => (...args) => {
    let h = state;
    for (let i = 0; i < args.length; i += 1) h = hashFloat(h, args[i]);
    return h * TO_UNIT;
  }],
  length: [1, 4, plain((...args) => {
    let sum = 0;
    for (let i = 0; i < args.length; i += 1) sum += args[i] * args[i];
    return Math.sqrt(sum);
  })],
  log: [1, 1, plain(Math.log)],
  max: [2, 8, plain(Math.max)],
  min: [2, 8, plain(Math.min)],
  mix: [3, 3, plain((a, b, t) => a + (b - a) * t)],
  noise: [2, 3, (state) => (x, y, z) => (z === undefined ? noise2(state, x, y) : noise3(state, x, y, z))],
  pow: [2, 2, plain(Math.pow)],
  sin: [1, 1, plain(Math.sin)],
  smoothstep: [3, 3, plain((e0, e1, x) => {
    if (e0 === e1) return x < e0 ? 0 : 1;
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  })],
  sqrt: [1, 1, plain(Math.sqrt)],
  step: [2, 2, plain((edge, x) => (x < edge ? 0 : 1))],
  tan: [1, 1, plain(Math.tan)],
}));

export const EXPRESSION_FUNCTIONS = Object.freeze(Object.keys(FUNCTIONS).sort());
export const EXPRESSION_CONSTANTS = Object.freeze(Object.keys(CONSTANTS));

function allowedNames(inputs) {
  return `allowed names: inputs ${inputs.length ? inputs.join(", ") : "(none)"}; constants ${EXPRESSION_CONSTANTS.join(", ")}; functions ${EXPRESSION_FUNCTIONS.join(", ")}`;
}

// ---- tokens ----

const NUMBER = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const OPERATORS = ["<=", ">=", "==", "!=", "<", ">", "+", "-", "*", "/", "^", "%", "(", ")", ","];

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(source);
    if (number) {
      const end = i + number[0].length;
      if (/[A-Za-z_]/.test(source[end] ?? "")) {
        throw new ExpressionError(`a name cannot follow a number directly; write ${number[0]} * ${source[end]}`, end);
      }
      tokens.push({ kind: "num", value: Number(number[0]), at: i });
      i = end;
      continue;
    }
    IDENT.lastIndex = i;
    const ident = IDENT.exec(source);
    if (ident) {
      tokens.push({ kind: "name", value: ident[0], at: i });
      i += ident[0].length;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") throw new ExpressionError("strings are not allowed; use numbers and names", i);
    if ("[]{}".includes(ch)) throw new ExpressionError("brackets [ ] { } are not allowed; use ( )", i);
    if (ch === ".") throw new ExpressionError("property access with . is not allowed", i);
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ExpressionError(`"${ch}" is not allowed; use numbers, names, + - * / ^ %, ( ), comparisons and commas`, i);
    tokens.push({ kind: "op", value: op, at: i });
    i += op.length;
  }
  tokens.push({ kind: "end", value: "", at: source.length });
  return tokens;
}

// ---- parser to a small tree ----

function parse(source, inputIndex, inputs) {
  const tokens = tokenize(source);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (value) => peek().kind === "op" && peek().value === value;
  const describe = (token) => (token.kind === "end" ? "the end" : `"${token.value}"`);
  const expect = (value) => {
    if (!isOp(value)) throw new ExpressionError(`expected "${value}" but found ${describe(peek())}`, peek().at);
    pos += 1;
  };
  const enter = () => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new ExpressionError(`nested deeper than ${MAX_DEPTH} levels`, peek().at);
  };

  const binaryLevel = (ops, next) => () => {
    let left = next();
    while (peek().kind === "op" && ops.includes(peek().value)) {
      const op = tokens[pos].value;
      pos += 1;
      left = { type: "bin", op, a: left, b: next() };
    }
    return left;
  };

  const unary = () => {
    enter();
    let node;
    if (isOp("-")) { pos += 1; node = { type: "neg", a: unary() }; }
    else if (isOp("+")) { pos += 1; node = unary(); }
    else node = power();
    depth -= 1;
    return node;
  };
  // ^ binds tighter than unary minus (-2^2 = -4) and is right-associative.
  const power = () => {
    const base = primary();
    if (!isOp("^")) return base;
    pos += 1;
    return { type: "bin", op: "^", a: base, b: unary() };
  };
  const multiplicative = binaryLevel(["*", "/", "%"], unary);
  const additive = binaryLevel(["+", "-"], multiplicative);
  const compare = binaryLevel(["<", "<=", ">", ">=", "==", "!="], additive);

  function primary() {
    const token = peek();
    if (token.kind === "num") { pos += 1; return { type: "num", value: token.value }; }
    if (token.kind === "op" && token.value === "(") {
      pos += 1;
      enter();
      const inner = compare();
      depth -= 1;
      expect(")");
      return inner;
    }
    if (token.kind === "name") {
      pos += 1;
      const name = token.value;
      if (isOp("(")) {
        if (!Object.hasOwn(FUNCTIONS, name)) {
          throw new ExpressionError(`"${name}" is not a function; ${allowedNames(inputs)}`, token.at);
        }
        pos += 1;
        const args = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(compare());
            if (!isOp(",")) break;
            pos += 1;
          }
        }
        expect(")");
        const [lo, hi] = FUNCTIONS[name];
        if (args.length < lo || args.length > hi) {
          const want = lo === hi ? `${lo}` : `${lo} to ${hi}`;
          throw new ExpressionError(`${name} takes ${want} values, got ${args.length}`, token.at);
        }
        return { type: "call", name, args };
      }
      if (Object.hasOwn(inputIndex, name)) return { type: "var", index: inputIndex[name] };
      if (Object.hasOwn(CONSTANTS, name)) return { type: "num", value: CONSTANTS[name] };
      if (Object.hasOwn(FUNCTIONS, name)) throw new ExpressionError(`${name} is a function; call it as ${name}( )`, token.at);
      throw new ExpressionError(`unknown name "${name}"; ${allowedNames(inputs)}`, token.at);
    }
    throw new ExpressionError(`expected a number, name or ( but found ${describe(token)}`, token.at);
  }

  if (tokens[0].kind === "end") throw new ExpressionError("the expression is empty");
  const tree = compare();
  if (peek().kind !== "end") throw new ExpressionError(`unexpected ${describe(peek())}; expected an operator`, peek().at);
  return tree;
}

// ---- compile the tree to closures (constants folded) ----

const BINARY = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a - b * Math.floor(a / b),
  "^": Math.pow,
  "<": (a, b) => (a < b ? 1 : 0),
  "<=": (a, b) => (a <= b ? 1 : 0),
  ">": (a, b) => (a > b ? 1 : 0),
  ">=": (a, b) => (a >= b ? 1 : 0),
  "==": (a, b) => (a === b ? 1 : 0),
  "!=": (a, b) => (a !== b ? 1 : 0),
};

function constant(value) {
  const fn = () => value;
  fn.constant = true;
  fn.value = value;
  return fn;
}

function compileNode(node, state) {
  switch (node.type) {
    case "num":
      return constant(node.value);
    case "var": {
      const i = node.index;
      return (env) => env[i];
    }
    case "neg": {
      const a = compileNode(node.a, state);
      return a.constant ? constant(-a.value) : (env) => -a(env);
    }
    case "bin": {
      const a = compileNode(node.a, state);
      const b = compileNode(node.b, state);
      const op = BINARY[node.op];
      if (a.constant && b.constant) return constant(op(a.value, b.value));
      switch (node.op) {
        case "+": return (env) => a(env) + b(env);
        case "-": return (env) => a(env) - b(env);
        case "*": return (env) => a(env) * b(env);
        case "/": return (env) => a(env) / b(env);
        default: return (env) => op(a(env), b(env));
      }
    }
    case "call": {
      const fn = FUNCTIONS[node.name][2](state);
      const args = node.args.map((arg) => compileNode(arg, state));
      if (args.every((arg) => arg.constant)) return constant(fn(...args.map((arg) => arg.value)));
      const [a, b, c, d] = args;
      switch (args.length) {
        case 1: return (env) => fn(a(env));
        case 2: return (env) => fn(a(env), b(env));
        case 3: return (env) => fn(a(env), b(env), c(env));
        case 4: return (env) => fn(a(env), b(env), c(env), d(env));
        default: return (env) => fn(...args.map((arg) => arg(env)));
      }
    }
    default:
      throw new ExpressionError(`internal: unknown node ${node.type}`);
  }
}

/**
 * Compiles `source` once. `inputs` names the values it may read, in order;
 * `seed` changes hash() and noise(). The result's run(array) takes one number
 * per input, in input order (fastest); evaluate(object) takes them by name and
 * reads a missing one as 0. A result that is not a finite number comes back 0.
 * % is floored (-1 % 3 = 2); comparisons give 1 or 0.
 */
export function compileExpression(source, { inputs = [], seed = 0 } = {}) {
  if (typeof source !== "string") throw new ExpressionError("the expression must be text");
  if (source.length > MAX_SOURCE) throw new ExpressionError(`the expression is longer than ${MAX_SOURCE} characters`);
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) throw new ExpressionError(`inputs must be a list of at most ${MAX_INPUTS} names`);
  const inputIndex = Object.create(null);
  inputs.forEach((name, index) => {
    if (typeof name !== "string" || !NAME.test(name)) throw new ExpressionError(`input name ${JSON.stringify(name)} must be letters, digits or _`);
    if (Object.hasOwn(FUNCTIONS, name) || Object.hasOwn(CONSTANTS, name)) throw new ExpressionError(`input name "${name}" is taken by a function or constant`);
    if (Object.hasOwn(inputIndex, name)) throw new ExpressionError(`input name "${name}" is listed twice`);
    inputIndex[name] = index;
  });
  const names = inputs.slice();
  const tree = parse(source, inputIndex, names);
  const body = compileNode(tree, seedState(seed));
  const read = new Set();
  const walk = (node) => {
    if (node.type === "var") read.add(names[node.index]);
    for (const child of [node.a, node.b, ...(node.args ?? [])]) if (child) walk(child);
  };
  walk(tree);
  const scratch = new Float64Array(names.length);
  const run = (env) => {
    const value = body(env);
    return Number.isFinite(value) ? value : 0;
  };
  const evaluate = (values = {}) => {
    for (let i = 0; i < names.length; i += 1) {
      const value = Number(values[names[i]]);
      scratch[i] = Number.isFinite(value) ? value : 0;
    }
    return run(scratch);
  };
  // used: the inputs the source names, in input order (a cache key can skip the others).
  return Object.freeze({ source, inputs: Object.freeze(names), used: Object.freeze(names.filter((name) => read.has(name))),
    constant: Boolean(body.constant), run, evaluate });
}
