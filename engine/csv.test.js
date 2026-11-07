import test from "node:test";
import assert from "node:assert/strict";
import { CsvError, parseCsv, writeCsv } from "./csv.js";
import { MAX_SCENES, MAX_STRING_LENGTH } from "./model.js";

test("parseCsv reads quoted cells, doubled quotes, and stray quotes in plain cells", () => {
  assert.deepEqual(parseCsv('name,quote,plain\nAda,"said ""hello""",a "quote" here'), {
    header: ["name", "quote", "plain"],
    rows: [["Ada", 'said "hello"', 'a "quote" here']],
  });
});

test("parseCsv accepts CRLF, LF, CR, and line breaks inside quoted cells", () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\n3,4\r5,"line one\r\nline two\nline three\rline four"\r'), {
    header: ["a", "b"],
    rows: [
      ["1", "2"],
      ["3", "4"],
      ["5", "line one\r\nline two\nline three\rline four"],
    ],
  });
});

test("parseCsv strips a leading BOM and ignores a blank final line", () => {
  assert.deepEqual(parseCsv("\uFEFFid,name\r\n1,Ada\r\n"), {
    header: ["id", "name"],
    rows: [["1", "Ada"]],
  });
  assert.deepEqual(parseCsv("id,name\r\n1,Ada\r\n\r\n"), {
    header: ["id", "name"],
    rows: [["1", "Ada"]],
  });
});

test("parseCsv keeps a quoted empty final record for CRLF, LF, and CR", () => {
  for (const newline of ["\r\n", "\n", "\r"]) {
    assert.deepEqual(parseCsv(`id${newline}""${newline}`), {
      header: ["id"],
      rows: [[""]],
    });
    assert.deepEqual(parseCsv(`id${newline}${newline}`), {
      header: ["id"],
      rows: [],
    });
  }
});

test("parseCsv keeps empty cells, including trailing cells", () => {
  assert.deepEqual(parseCsv("a,,c\n,\n"), {
    header: ["a", "", "c"],
    rows: [["", ""]],
  });
});

test("parseCsv reports an unterminated quoted cell at its opening line", () => {
  assert.throws(
    () => parseCsv('a,b\n1,"unfinished\ncontinued'),
    (error) => error instanceof CsvError && error.line === 2 && /line 2/i.test(error.message),
  );
});

test("parseCsv chooses semicolon when the header has semicolons and no commas", () => {
  assert.deepEqual(parseCsv("id;Title;info_log\nalpha;A title;"), {
    header: ["id", "Title", "info_log"],
    rows: [["alpha", "A title", ""]],
  });
});

test("parseCsv honors an explicit delimiter", () => {
  assert.deepEqual(parseCsv("a;b,c\n1;2,3", { delimiter: ";" }), {
    header: ["a", "b,c"],
    rows: [["1", "2,3"]],
  });
});

test("writeCsv uses a BOM and CRLF, quoting commas, quotes, and line breaks", () => {
  const csv = writeCsv([
    ["name", "note"],
    ["Ada", 'said "hello", then\nleft'],
  ]);
  assert.equal(csv, '\uFEFFname,note\r\nAda,"said ""hello"", then\nleft"');
  assert.deepEqual(parseCsv(csv), {
    header: ["name", "note"],
    rows: [["Ada", 'said "hello", then\nleft']],
  });
});

test("writeCsv can omit the BOM", () => {
  assert.equal(writeCsv([["id"], ["one"]], { bom: false }), "id\r\none");
});

test("writeCsv round-trips a trailing single-cell empty row", () => {
  const csv = writeCsv([["id"], [""]], { bom: false });
  assert.deepEqual(parseCsv(csv), { header: ["id"], rows: [[""]] });
});

test("writeCsv protects formulas and parseCsv reverses only the protection convention", () => {
  const original = [
    "=1+1",
    "+SUM(A1:A2)",
    "-2+3",
    "@command",
    "\tvalue",
    "\rvalue",
    "'=1+1",
    "''=1+1",
    "plain '= value",
  ];
  const written = writeCsv([ ["value"], ...original.map((value) => [value]) ], { bom: false });
  assert.deepEqual(parseCsv(written).rows.map(([value]) => value), original);
  assert.match(written, /\r\n'=1\+1\r\n/);
  // A leading apostrophe before a hazardous character is an escape marker. The writer doubles
  // the full leading apostrophe run for literal values, and the parser removes one marker.
  assert.match(written, /\r\n''=1\+1\r\n/);
  assert.deepEqual(parseCsv("value\n'=1\n'plain\n''=1").rows, [["=1"], ["'plain"], ["'=1"]]);
});

test("parseCsv rejects inputs over 2 MiB of UTF-8", () => {
  const multibyte = "é".repeat(1_100_000);
  assert.ok(multibyte.length <= MAX_STRING_LENGTH);
  assert.throws(() => parseCsv(`value\n${multibyte}`), (error) => error instanceof CsvError && /2 MiB/i.test(error.message));
});

test("parseCsv enforces the column limit", () => {
  const header = Array.from({ length: 257 }, (_, index) => `c${index}`).join(",");
  assert.throws(() => parseCsv(header), (error) => error instanceof CsvError && /256 columns/i.test(error.message));
});

test("parseCsv allows MAX_SCENES plus one data rows and rejects the next row", () => {
  const allowed = `id\n${Array.from({ length: MAX_SCENES + 1 }, (_, index) => index).join("\n")}`;
  assert.equal(parseCsv(allowed).rows.length, MAX_SCENES + 1);
  assert.throws(
    () => parseCsv(`${allowed}\nextra`),
    (error) => error instanceof CsvError && new RegExp(`${MAX_SCENES + 1} data rows`).test(error.message),
  );
});

test("parseCsv enforces MAX_STRING_LENGTH for a cell", () => {
  const cell = "x".repeat(MAX_STRING_LENGTH + 1);
  assert.throws(
    () => parseCsv(`id\n${cell}`),
    (error) => error instanceof CsvError && /cell exceeds.*character limit/i.test(error.message),
  );
});
