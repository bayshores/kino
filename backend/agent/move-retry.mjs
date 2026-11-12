// A refused move op's retry: the agent's own op, not the library example of the move.
// Where the refusal's words say the fix (a dur under the move's shortest, a number out of its
// range, a choice that is not one of the values, a field the move does not have), the op comes
// back with only that field fixed. Where they only name the field, the op comes back with that
// field set to words in angle brackets ("<your to>") for the agent to fill in. Null when the
// refusal names no field of the op: the move's library example is shown then.
import { MOVES } from "../../engine/blocks/moves/index.js";
import { nearMiss } from "./refs.mjs";

// Fields every move op takes besides its own (blocks.mjs MOVE_KEYS), and the id.
const SHARED = ["at", "align", "dur", "seed", "reduced", "look", "brand", "feel", "id"];
const NUMBER = /^(\S+) (\w+)(?:\.(\w+))? must be a number from (-?[\d.]+) to (-?[\d.]+)\./;
// "zoom-through feel is one of ..." and "feel is one of ..." (blocks.mjs) both name the field.
const CHOICE = /^(?:\S+ )?(\w+) is one of (.+)\.$/;
const YES = new Set(["true", "yes", "on", "1"]);
const NO = new Set(["false", "no", "off", "0"]);

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const without = (operation, key) => Object.fromEntries(Object.entries(operation).filter(([name]) => name !== key));

/** The op to send again for a refusal `message` of the move op `operation`, or null. */
export function moveRetry(operation, message, suggestions = []) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
  if ((operation.op ?? operation.type) !== "move" || typeof operation.name !== "string") return null;
  const definition = MOVES[operation.name];
  if (!definition) {
    const name = suggestions.find((choice) => MOVES[choice]);
    return name ? { ...operation, name } : null;
  }
  const text = String(message ?? "");
  const fields = Object.keys(definition.fields);

  // Shorter than the move's shortest: one frame when the move has frames, else its shortest dur.
  const shortest = /needs dur of at least ([\d.]+) s/.exec(text);
  if (shortest) return /frames:1 for one frame/.test(text) ? { ...without(operation, "dur"), frames: 1 } : { ...operation, dur: Number(shortest[1]) };
  if (/takes frames or dur, not both/.test(text)) return without(operation, "dur");

  const unknown = /has no field "([^"]+)"/.exec(text)?.[1];
  if (unknown) {
    const near = nearMiss(unknown, fields);
    return near && operation[near] === undefined ? { ...without(operation, unknown), [near]: operation[unknown] } : without(operation, unknown);
  }

  const range = NUMBER.exec(text);
  if (range) {
    const [, , key, inner, low, high] = range;
    const holder = inner ? operation[key] : operation;
    const name = inner ?? key;
    const value = Number(holder?.[name]);
    if (holder && typeof holder === "object" && holder[name] !== undefined && Number.isFinite(value)) {
      const fixed = clamp(value, Number(low), Number(high));
      return inner ? { ...operation, [key]: { ...holder, [name]: fixed } } : { ...operation, [key]: fixed };
    }
  }
  const seconds = /^(\S+) (\w+) must be seconds from 0 to 600\./.exec(text);
  if (seconds && Number.isFinite(Number(operation[seconds[2]]))) return { ...operation, [seconds[2]]: clamp(Number(operation[seconds[2]]), 0, 600) };

  const choice = CHOICE.exec(text);
  if (choice) {
    const [, key, list] = choice;
    const values = list.split(", ");
    const pick = nearMiss(String(operation[key]), values);
    if (pick && operation[key] !== undefined) return { ...operation, [key]: pick };
  }

  // "needs exactly one of words or text" with both sent: the first one sent stays.
  const oneOf = /needs exactly one of ([\w ]+?)\./.exec(text);
  if (oneOf) {
    const sent = oneOf[1].split(" or ").filter((key) => operation[key] !== undefined);
    if (sent.length > 1) return sent.slice(1).reduce(without, operation);
  }
  // "reduced is true or false." with "yes" or "no" sent: the true or false it means.
  const flag = /^(\w+) is true or false\./.exec(text)?.[1];
  const said = flag ? String(operation[flag]).toLowerCase() : "";
  if (flag && (YES.has(said) || NO.has(said))) return { ...operation, [flag]: YES.has(said) };

  // The refusal only names a field: the op as sent, that field in words for the agent to fill.
  const missing = /\bneeds (\w+)\b/.exec(text)?.[1];
  const candidates = new Set([...fields, ...SHARED]);
  const words = text.split(/[^\w-]+/).filter(Boolean);
  const key = missing && candidates.has(missing) ? missing : words.slice(words[0] === definition.name ? 1 : 0).find((word) => candidates.has(word));
  if (!key) return null;
  return { ...operation, [key]: `<your ${key}>` };
}
