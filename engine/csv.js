import { MAX_SCENES, MAX_STRING_LENGTH } from "./model.js";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_COLUMNS = 256;
const MAX_DATA_ROWS = MAX_SCENES + 1;
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** A CSV input error with the physical line on which it was found. */
export class CsvError extends Error {
  constructor(message, line = 1) {
    super(`${message} (line ${line})`);
    this.name = "CsvError";
    this.line = line;
  }
}

function isFormulaPrefix(character) {
  return FORMULA_PREFIXES.has(character);
}

export function csvUtf8Length(text) {
  return new TextEncoder().encode(text).length;
}

function detectDelimiter(text) {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  let fieldIsEmpty = true;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') index += 1;
        else inQuotes = false;
      }
      continue;
    }

    if (character === "\r" || character === "\n") break;
    if (character === '"' && fieldIsEmpty) {
      inQuotes = true;
    } else if (character === ",") {
      commas += 1;
      fieldIsEmpty = true;
    } else if (character === ";") {
      semicolons += 1;
      fieldIsEmpty = true;
    } else {
      fieldIsEmpty = false;
    }
  }

  return semicolons > 0 && commas === 0 ? ";" : ",";
}

function parseDelimiter(delimiter) {
  if (
    typeof delimiter !== "string" ||
    delimiter.length !== 1 ||
    delimiter === '"' ||
    delimiter === "\r" ||
    delimiter === "\n"
  ) {
    throw new CsvError("Delimiter must be one character other than a quote or line break");
  }
  return delimiter;
}

// Formula protection uses an apostrophe before a dangerous first character. When the source
// value itself begins with apostrophes followed by a dangerous character, writeCsv adds one more
// apostrophe. Removing one from that leading run reverses both cases without losing literal data.
function unprotectFormulaCell(value) {
  let apostrophes = 0;
  while (value[apostrophes] === "'") apostrophes += 1;
  return apostrophes > 0 && isFormulaPrefix(value[apostrophes])
    ? value.slice(1)
    : value;
}

function finishCell(value, line) {
  const cell = unprotectFormulaCell(value);
  if (cell.length > MAX_STRING_LENGTH) {
    throw new CsvError(`Cell exceeds the ${MAX_STRING_LENGTH} character limit`, line);
  }
  return cell;
}

/**
 * Parse a CSV document whose first record is the header. Quoted field newlines are preserved
 * exactly as written; CRLF, LF, and CR outside quotes each end one record.
 */
export function parseCsv(input, { delimiter } = {}) {
  if (typeof input !== "string") throw new CsvError("CSV input must be text");
  if (csvUtf8Length(input) > MAX_CSV_BYTES) {
    throw new CsvError("CSV exceeds the 2 MiB input limit");
  }

  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  if (text.length === 0) return { header: [], rows: [] };

  const separator = delimiter === undefined
    ? detectDelimiter(text)
    : parseDelimiter(delimiter);
  const records = [];
  let fields = [];
  let value = "";
  let line = 1;
  let quotedAtLine = 1;
  let inQuotes = false;
  let afterQuote = false;
  let recordHasContent = false;

  const finishRecord = ({ finalBlankLine = false } = {}) => {
    fields.push(finishCell(value, line));
    if (finalBlankLine && !recordHasContent && records.length > 0 && fields.length === 1 && fields[0] === "") {
      fields = [];
      value = "";
      afterQuote = false;
      recordHasContent = false;
      return;
    }
    if (fields.length > MAX_COLUMNS) {
      throw new CsvError(`CSV rows may contain at most ${MAX_COLUMNS} columns`, line);
    }
    records.push(fields);
    if (records.length > 1 && records.length - 1 > MAX_DATA_ROWS) {
      throw new CsvError(`CSV may contain at most ${MAX_DATA_ROWS} data rows`, line);
    }
    fields = [];
    value = "";
    afterQuote = false;
    recordHasContent = false;
  };

  const finishLine = (index, character) => {
    const finalLineEnding = index === text.length - 1 ||
      (character === "\r" && text[index + 1] === "\n" && index + 1 === text.length - 1);
    finishRecord({ finalBlankLine: finalLineEnding });
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (character === "\r" || character === "\n") {
        if (character === "\r" && text[index + 1] === "\n") {
          value += "\r\n";
          index += 1;
        } else {
          value += character;
        }
        line += 1;
      } else {
        value += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === separator) {
        fields.push(finishCell(value, line));
        if (fields.length >= MAX_COLUMNS) {
          throw new CsvError(`CSV rows may contain at most ${MAX_COLUMNS} columns`, line);
        }
        value = "";
        afterQuote = false;
        recordHasContent = true;
      } else if (character === "\r" || character === "\n") {
        finishLine(index, character);
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        line += 1;
      } else {
        throw new CsvError("Unexpected character after a closing quote", line);
      }
      continue;
    }

    if (character === separator) {
      fields.push(finishCell(value, line));
      if (fields.length >= MAX_COLUMNS) {
        throw new CsvError(`CSV rows may contain at most ${MAX_COLUMNS} columns`, line);
      }
      value = "";
      recordHasContent = true;
    } else if (character === "\r" || character === "\n") {
      finishLine(index, character);
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      line += 1;
    } else if (character === '"' && value.length === 0) {
      inQuotes = true;
      quotedAtLine = line;
      recordHasContent = true;
    } else {
      value += character;
      recordHasContent = true;
    }
  }

  if (inQuotes) throw new CsvError("Unterminated quoted cell", quotedAtLine);
  if (recordHasContent || fields.length > 0 || value.length > 0 || afterQuote) finishRecord();

  if (records.length === 0) return { header: [], rows: [] };
  return { header: records[0], rows: records.slice(1) };
}

function protectFormulaCell(value) {
  if (isFormulaPrefix(value[0])) return `'${value}`;

  if (value[0] === "'") {
    let apostrophes = 0;
    while (value[apostrophes] === "'") apostrophes += 1;
    if (isFormulaPrefix(value[apostrophes])) return `'${value}`;
  }

  return value;
}

function quoteCell(value, force = false) {
  const protectedValue = protectFormulaCell(value);
  return force || /[,"\r\n]/.test(protectedValue)
    ? `"${protectedValue.replaceAll('"', '""')}"`
    : protectedValue;
}

/** Write rows as comma-separated CSV with CRLF record endings and a BOM by default. */
export function writeCsv(rows, { bom = true } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("CSV rows must be an array");
  const output = rows.map((row) => {
    if (!Array.isArray(row)) throw new TypeError("Each CSV row must be an array");
    return row.map((cell) => {
      const value = cell == null ? "" : String(cell);
      return quoteCell(value, row.length === 1 && value === "");
    }).join(",");
  }).join("\r\n");
  return `${bom ? "\uFEFF" : ""}${output}`;
}
