// Stored style/caret offsets use the raw UTF-16 string. Layout uses normalized,
// cased display text. Keep their mapping in one place, including CRLF and ß→SS.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function textGraphemes(text) {
  return [...segmenter.segment(String(text ?? ""))].map((part) => ({
    text: part.segment, start: part.index, end: part.index + part.segment.length,
  }));
}

export function displayText(layer) {
  const text = String(layer.text ?? "").replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n");
  return layer.textCase === "upper" ? text.toLocaleUpperCase()
    : layer.textCase === "lower" ? text.toLocaleLowerCase() : text;
}

export function textSourceMap(layer) {
  const rawText = String(layer.text ?? "");
  const text = displayText(layer).normalize("NFC");
  let displayOffset = 0;
  const clusters = textGraphemes(rawText).map((part) => {
    const displayStart = displayOffset;
    displayOffset += displayText({ text: part.text, textCase: layer.textCase }).normalize("NFC").length;
    return { ...part, displayStart, displayEnd: displayOffset };
  });
  // Contextual casing can change a glyph (Greek final sigma), while its span
  // retains the same length. Never silently assign a changed length to the tail.
  if (displayOffset !== text.length) throw new Error("This text's case conversion could not preserve its source ranges.");
  return { rawText, text, clusters,
    boundaries: [0, ...clusters.map((part) => part.end)],
    displayOffsets: [0, ...clusters.map((part) => part.displayEnd)] };
}
