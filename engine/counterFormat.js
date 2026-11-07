// The number format of a Counter (counter.js): how the number in a text layer's text is written,
// so every number the Counter counts through is written the same way.
//
// The Counter keeps the format of the number on the canvas: plain numbers (42), decimals (1234.5678), negatives,
// percentages and grouped numbers (-1,234.5%), currency ($42), units (42kg), all of them at once
// ($1,234.50kg), thousands separators written with a comma (1,234), a dot (1.234) or a space
// (1 000 000), "." as the decimal separator, and zero padding (0000, 001,234.50).
//
// parseCounterText reads a text into a format:
//   { value, prefix, suffix, signAt, minus, plus, separator, minDigits, decimals }
// - `value` is the number itself (-1234.5 for "-1,234.5%").
// - `prefix` and `suffix` are the text before and after the number ("$", "kg", "%", " points"),
//   without the sign. Only the first number in the text counts; anything after it is suffix.
// - `signAt` is where in the prefix the sign goes, so "-$5" keeps its sign before the "$" and
//   "$-5" keeps it after. Text without a sign puts a minus before a currency sign that is right
//   before the number ("$5" counts down to "-$5") and right before the digits otherwise.
// - `minus` is the minus sign the text uses ("-" or the typographic "−"); `plus` is true when
//   the text shows "+" before positive numbers. Zero never shows a sign.
// - `separator` is the thousands separator: ",", ".", " " (or a no-break space), or "" for none.
// - `minDigits` is how many digits the whole part has at least: 1, the number of digits when the
//   text is zero padded ("0042" has 4, "001,234.50" has 6; more digits are added when the number
//   grows past them), or 0 when the text starts at the decimal point (".5").
// - `decimals` is the number of digits after the decimal point.
//
// Rules for the cases the help article doesn't settle (kino's choices, see COMPATIBILITY.md):
// - A "-" or "+" counts as a sign only at the start of the text or after something that is not
//   a letter or digit, so "Day-5" is "Day-" followed by 5, while "(-5)" and "Total: -5" are -5.
// - Groups have exactly three digits after the first group of one to three: "1,234" is grouped,
//   "1,23" is the number 1 followed by ",23", and "1234,567" is 1234 followed by ",567".
// - "." is the decimal separator, except that two or more dot groups ("1.234.567") or a single
//   dot followed by exactly three digits after a whole part of one to three digits that doesn't
//   start with 0 ("1.234", "12.500") are a dot thousands separator. "0.125", "1.5" and
//   "1234.567" are decimals. A comma after dot groups is not a decimal point ("1.234,56" is
//   1234 followed by ",56"), because "." is the only decimal separator.
// - A number with decimals can't also be grouped with dots, so a dot-grouped text counting by
//   decimals ("1.234" with a Step of 0.5) drops the dots: "1234.5".
//
// formatCounterValue writes any number back in a format, with a given number of decimals. Plain
// functions without React or the DOM, so they can be tested.

// More decimals than this are rounded away; JavaScript numbers hold about 15 significant digits.
export const MAX_COUNTER_DECIMALS = 10;

const MINUS_SIGNS = new Set(["-", "−"]);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const CURRENCY_RUN = /\p{Sc}+$/u;
// Comma, space, no-break space or narrow no-break space groups: "1,234", "1 000 000".
const GROUPED = /^(\d{1,3})(?:([,   ])\d{3})(?:\2\d{3})*(?!\d)/u;
// Two or more dot groups: "1.234.567".
const DOT_GROUPS = /^\d{1,3}(?:\.\d{3}){2,}(?!\d)/u;
// One dot group: "1.234" (but not "0.125").
const DOT_GROUP = /^[1-9]\d{0,2}\.\d{3}(?!\d)/u;
const PLAIN = /^(\d+)(?:\.(\d+))?/u;
const FRACTION_ONLY = /^\.(\d+)/u;

function isSign(character) {
  return character === "+" || MINUS_SIGNS.has(character);
}

// A sign at `index` of `text` belongs to the number when nothing word-like is right before it.
function signAllowed(text, index) {
  return index === 0 || !LETTER_OR_DIGIT.test(text[index - 1]);
}

// The number's digits at the start of `rest`: { whole, fraction, separator, length }.
function readNumber(rest) {
  const fractionOnly = FRACTION_ONLY.exec(rest);
  if (fractionOnly) return { whole: "", fraction: fractionOnly[1], separator: "", length: fractionOnly[0].length };
  const grouped = GROUPED.exec(rest);
  if (grouped) {
    const separator = grouped[2];
    const decimals = /^\.(\d+)/u.exec(rest.slice(grouped[0].length));
    return {
      whole: grouped[0].split(separator).join(""),
      fraction: decimals ? decimals[1] : "",
      separator,
      length: grouped[0].length + (decimals ? decimals[0].length : 0),
    };
  }
  const dots = DOT_GROUPS.exec(rest) ?? DOT_GROUP.exec(rest);
  if (dots) return { whole: dots[0].split(".").join(""), fraction: "", separator: ".", length: dots[0].length };
  const plain = PLAIN.exec(rest);
  return { whole: plain[1], fraction: plain[2] ?? "", separator: "", length: plain[0].length };
}

/**
 * The format of the first number in `text`, or null when the text has no digits. See the top of
 * this file for what each field means.
 */
export function parseCounterText(text) {
  const source = typeof text === "string" ? text : String(text ?? "");
  const found = /\d|\.(?=\d)/u.exec(source);
  if (!found) return null;
  const number = readNumber(source.slice(found.index));
  let prefix = source.slice(0, found.index);
  const suffix = source.slice(found.index + number.length);
  let sign = "";
  let signAt;
  const last = prefix.length - 1;
  if (last >= 0 && isSign(prefix[last]) && signAllowed(prefix, last)) {
    // "-5", "$-5": the sign is right before the digits.
    sign = prefix[last];
    prefix = prefix.slice(0, last);
    signAt = prefix.length;
  } else {
    // "-$5": the sign is before a currency sign that is right before the digits.
    const currency = CURRENCY_RUN.exec(prefix);
    const at = currency ? currency.index - 1 : -1;
    if (at >= 0 && isSign(prefix[at]) && signAllowed(prefix, at)) {
      sign = prefix[at];
      prefix = prefix.slice(0, at) + prefix.slice(at + 1);
      signAt = at;
    } else {
      signAt = currency ? currency.index : prefix.length;
    }
  }
  const magnitude = Number(`${number.whole || "0"}.${number.fraction || "0"}`);
  const zeroPadded = number.whole.length > 1 && number.whole.startsWith("0");
  return {
    value: MINUS_SIGNS.has(sign) && magnitude !== 0 ? -magnitude : magnitude,
    prefix,
    suffix,
    signAt,
    minus: MINUS_SIGNS.has(sign) ? sign : "-",
    plus: sign === "+",
    separator: number.separator,
    minDigits: zeroPadded ? number.whole.length : number.whole ? 1 : 0,
    decimals: Math.min(MAX_COUNTER_DECIMALS, number.fraction.length),
  };
}

/** The format of a text without a number: just the number, with a minus when it is negative. */
export function plainCounterFormat(decimals = 0) {
  return { value: 0, prefix: "", suffix: "", signAt: 0, minus: "-", plus: false, separator: "", minDigits: 1, decimals: wholeDecimals(decimals) };
}

function wholeDecimals(decimals) {
  const count = Math.floor(Number(decimals));
  return Number.isFinite(count) ? Math.max(0, Math.min(MAX_COUNTER_DECIMALS, count)) : 0;
}

/**
 * How many decimals a number has as it was typed: 0 for 5, 2 for 1.25, 7 for 1e-7. A last-digit
 * rounding error of floating-point sums (0.1 + 0.2 is 0.30000000000000004) doesn't count, and
 * at most MAX_COUNTER_DECIMALS are counted.
 */
export function decimalPlaces(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return 0;
  // 15 significant digits drop the rounding error; String writes 1e-7 as "1e-7".
  const [mantissa, exponent = "0"] = String(Number(number.toPrecision(15))).split("e");
  const decimals = (mantissa.split(".")[1] ?? "").length - Number(exponent);
  return Math.max(0, Math.min(MAX_COUNTER_DECIMALS, decimals));
}

// "1234567" → "1,234,567" with `separator`.
function groupDigits(digits, separator) {
  let grouped = "";
  for (let end = digits.length; end > 0; end -= 3) {
    const group = digits.slice(Math.max(0, end - 3), end);
    grouped = grouped ? `${group}${separator}${grouped}` : group;
  }
  return grouped;
}

/**
 * `value` written in `format` (parseCounterText) with `decimals` digits after the point (the
 * format's own when left out): its prefix and suffix, sign, zero padding, thousands separator
 * and decimals. formatCounterValue(parseCounterText(text), parseCounterText(text).value) gives
 * the text back.
 */
export function formatCounterValue(format, value, decimals = format?.decimals) {
  const places = wholeDecimals(decimals);
  const number = Number.isFinite(Number(value)) ? Number(value) : 0;
  const fixed = Math.abs(number).toFixed(places);
  let [whole, fraction = ""] = fixed.split(".");
  const isZero = !/[1-9]/u.test(fixed);
  if (format.minDigits === 0 && whole === "0" && places > 0) whole = "";
  whole = whole.padStart(format.minDigits, "0");
  // A dot can't be the thousands separator and the decimal point at once.
  if (format.separator && !(format.separator === "." && places > 0)) whole = groupDigits(whole, format.separator);
  const sign = isZero ? "" : number < 0 ? format.minus : format.plus ? "+" : "";
  const prefix = format.prefix.slice(0, format.signAt) + sign + format.prefix.slice(format.signAt);
  return `${prefix}${whole}${places > 0 ? `.${fraction}` : ""}${format.suffix}`;
}
