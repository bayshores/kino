// The Counter's number format (counterFormat.js): reading the number in a text and writing any
// value back the same way, including the edge cases.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_COUNTER_DECIMALS, decimalPlaces, formatCounterValue, parseCounterText, plainCounterFormat } from "./counterFormat.js";

const roundTrip = (text) => {
  const format = parseCounterText(text);
  return formatCounterValue(format, format.value);
};
const counted = (text, value, decimals) => {
  const format = parseCounterText(text);
  return formatCounterValue(format, value, decimals ?? format.decimals);
};

test("every supported format reads its number and writes it back unchanged", () => {
  // Plain, decimals, negative percent, currency, units, all at
  // once, the three thousands separators and the zero padding examples.
  const cases = [
    ["42", 42],
    ["1234.5678", 1234.5678],
    ["-1,234.5%", -1234.5],
    ["$42", 42],
    ["42kg", 42],
    ["$1,234.50kg", 1234.5],
    ["1,234", 1234],
    ["1.234", 1234],
    ["1 000 000", 1000000],
    ["0000", 0],
    ["001,234.50", 1234.5],
  ];
  for (const [text, value] of cases) {
    assert.equal(parseCounterText(text).value, value, text);
    assert.equal(roundTrip(text), text, text);
  }
});

test("other texts with a number round-trip too", () => {
  for (const text of ["Score: 0", "+3", "−7", "-$5", "$-5", "(-5)", ".5", "Day-5", "1,234,567.89 USD", "€0.00", "100%", "0042 points", "1 234", "x1"])
    assert.equal(roundTrip(text), text, text);
});

test("the fields of a parsed text", () => {
  assert.deepEqual(parseCounterText("$1,234.50kg"), {
    value: 1234.5, prefix: "$", suffix: "kg", signAt: 0, minus: "-", plus: false, separator: ",", minDigits: 1, decimals: 2,
  });
  assert.deepEqual(parseCounterText("001,234.50"), {
    value: 1234.5, prefix: "", suffix: "", signAt: 0, minus: "-", plus: false, separator: ",", minDigits: 6, decimals: 2,
  });
  // Only the first number counts; the rest is suffix.
  assert.equal(parseCounterText("3 of 10").value, 3);
  assert.equal(parseCounterText("3 of 10").suffix, " of 10");
});

test("a text without digits has no number", () => {
  for (const text of ["", "Hello", "$", "-", ".", "%", null, undefined]) assert.equal(parseCounterText(text), null, String(text));
});

test("the sign keeps its place relative to the prefix", () => {
  // Before the currency sign stays before it, after it stays after it.
  assert.equal(counted("-$5", -12), "-$12");
  assert.equal(counted("$-5", -12), "$-12");
  // Without a sign, a minus goes before a currency sign that is right before the digits ...
  assert.equal(counted("$5", -12), "-$12");
  assert.equal(counted("Total $5", -3), "Total -$3");
  // ... and right before the digits otherwise.
  assert.equal(counted("Score 5", -3), "Score -3");
  assert.equal(counted("5kg", -3), "-3kg");
  // A typographic minus stays typographic; a plus shows on positive numbers.
  assert.equal(counted("−7", -8), "−8");
  assert.equal(counted("+3", 4), "+4");
  assert.equal(counted("+3", -4), "-4");
  // Zero never shows a sign, even when rounding makes the shown digits zero.
  assert.equal(counted("-5", 0), "0");
  assert.equal(counted("+5", 0), "0");
  assert.equal(counted("-5.0", -0.04), "0.0");
});

test("a minus right after a letter or digit is part of the prefix", () => {
  const format = parseCounterText("Day-5");
  assert.equal(format.value, 5);
  assert.equal(format.prefix, "Day-");
  assert.equal(formatCounterValue(format, 6), "Day-6");
  // After a space or a bracket it is a sign.
  assert.equal(parseCounterText("Total: -5").value, -5);
  assert.equal(parseCounterText("(-5)").value, -5);
});

test("when a dot is a thousands separator", () => {
  // Two or more dot groups, or one dot then exactly three digits after 1 to 3 digits not starting with 0.
  assert.equal(parseCounterText("1.234.567").value, 1234567);
  assert.equal(parseCounterText("1.234.567").separator, ".");
  assert.equal(parseCounterText("12.500").value, 12500);
  assert.equal(parseCounterText("999.000").separator, ".");
  // Decimals otherwise.
  for (const [text, value] of [["0.125", 0.125], ["1.5", 1.5], ["1234.567", 1234.567], ["1.2345", 1.2345], ["1.23", 1.23]]) {
    assert.equal(parseCounterText(text).value, value, text);
    assert.equal(parseCounterText(text).separator, "", text);
  }
  // "." is the only decimal separator: a comma after dot groups is suffix.
  assert.equal(parseCounterText("1.234,56").value, 1234);
  assert.equal(parseCounterText("1.234,56").suffix, ",56");
  // Counting keeps dot groups ...
  assert.equal(counted("1.234", 1234567), "1.234.567");
  assert.equal(counted("1.234", 999), "999");
  // ... and drops them when the numbers have decimals, so the dot stays the decimal point.
  assert.equal(counted("1.234", 1234.5, 1), "1234.5");
});

test("comma and space groups need three digits per group", () => {
  assert.equal(parseCounterText("1,23").value, 1);
  assert.equal(parseCounterText("1,23").suffix, ",23");
  assert.equal(parseCounterText("1234,567").value, 1234);
  assert.equal(parseCounterText("1 000 000").separator, " ");
  assert.equal(counted("1 000", 1234567), "1 234 567");
  assert.equal(counted("1,000", 12), "12");
  assert.equal(counted("1,000", -1234567.5, 1), "-1,234,567.5");
});

test("zero padding grows when the number needs more digits", () => {
  assert.equal(counted("0000", 7), "0007");
  assert.equal(counted("0000", 999), "0999");
  assert.equal(counted("0000", 1000), "1000");
  assert.equal(counted("0000", 12345), "12345");
  assert.equal(counted("001,234.50", 5), "000,005.00");
  assert.equal(counted("001,234.50", 1234567.25), "1,234,567.25");
  // One leading 0 alone is not padding.
  assert.equal(parseCounterText("0").minDigits, 1);
  assert.equal(counted("0", 42), "42");
  assert.equal(counted("0.5", 12.25, 2), "12.25");
});

test("negative values keep the padding after the sign", () => {
  assert.equal(counted("0000", -7), "-0007");
  assert.equal(counted("-0042", -1234), "-1234");
  assert.equal(counted("$0005", -3), "-$0003");
  assert.equal(counted("001,234.50", -5), "-000,005.00");
});

test("a text that starts at the decimal point keeps no whole digit", () => {
  assert.equal(counted(".5", 0.75, 2), ".75");
  assert.equal(counted(".5", 1.5), "1.5");
  assert.equal(counted(".5", -0.25, 2), "-.25");
});

test("the number of decimals is the one given, rounded half away from zero by toFixed", () => {
  assert.equal(counted("42", 1.5, 1), "1.5");
  assert.equal(counted("42.00", 7), "7.00");
  assert.equal(counted("1,234.5%", 1000.25, 2), "1,000.25%");
  assert.equal(formatCounterValue(plainCounterFormat(3), -2.5), "-2.500");
  assert.equal(formatCounterValue(plainCounterFormat(), 1e15), "1000000000000000");
});

test("decimal places of a typed number", () => {
  assert.equal(decimalPlaces(5), 0);
  assert.equal(decimalPlaces(-5), 0);
  assert.equal(decimalPlaces(1.25), 2);
  assert.equal(decimalPlaces(0.1 + 0.2), 1);
  assert.equal(decimalPlaces(1e-7), 7);
  assert.equal(decimalPlaces(1e15), 0);
  assert.equal(decimalPlaces(Math.PI), MAX_COUNTER_DECIMALS);
  assert.equal(decimalPlaces(Number.NaN), 0);
  // The text's own decimals are capped at the same limit.
  assert.equal(parseCounterText("0.123456789012345").decimals, MAX_COUNTER_DECIMALS);
});
