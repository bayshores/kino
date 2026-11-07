// Reads and writes subtitle files: SubRip (.srt) and WebVTT (.vtt). No library: both formats are
// plain text. An event is {start, end, text, words?}: times in seconds, text with "\n" between
// lines. VTT cues may carry word times as inline timestamps ("<00:00:01.500>word"); those become
// words [{text, start, end}].
//
// Formats: SubRip as commonly written (numbered blocks, "HH:MM:SS,mmm --> HH:MM:SS,mmm");
// WebVTT per https://www.w3.org/TR/webvtt1/ (header, optional cue identifiers and settings,
// NOTE / STYLE / REGION blocks skipped, inline tags removed).

export const MAX_SUBTITLE_EVENTS = 2000;
export const MAX_SUBTITLE_CHARACTERS = 1_000_000;

const TIME = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)[,.](\d{1,3})$/;

/** Seconds from "01:02:03,450", "01:02:03.450" or "02:03.450". Null when it is not a time. */
export function parseTimestamp(value) {
  const match = TIME.exec(String(value).trim());
  if (!match) return null;
  const [, hours = "0", minutes, seconds, fraction] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction.padEnd(3, "0")) / 1000;
}

function timing(line) {
  const match = /^\s*(\S+)\s+-->\s+(\S+)/.exec(line);
  if (!match) return null;
  const start = parseTimestamp(match[1]);
  const end = parseTimestamp(match[2]);
  return start === null || end === null ? null : { start, end };
}

// Text without markup: <i>, <b>, <font …>, {\an8}, <c.class>, <v Speaker>; entities decoded.
function plainText(text) {
  return text
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&lrm;|&rlm;/g, "")
    .split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

// Word times from VTT inline timestamps: each timestamp starts the words after it.
function inlineWords(raw, start, end) {
  if (!/<\d{1,3}:\d\d(?::\d\d)?[.,]\d{1,3}>/.test(raw) && !/<\d\d:\d\d[.,]\d{3}>/.test(raw)) return undefined;
  const parts = raw.replace(/\n/g, " ").split(/<((?:\d{1,3}:)?\d\d:\d\d[.,]\d{1,3})>/);
  const words = [];
  let time = start;
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 1) { time = parseTimestamp(parts[index]) ?? time; continue; }
    for (const word of plainText(parts[index]).split(/\s+/).filter(Boolean)) words.push({ text: word, start: time });
  }
  for (let index = 0; index < words.length; index += 1) words[index].end = index + 1 < words.length ? Math.max(words[index].start, words[index + 1].start) : end;
  return words.length ? words : undefined;
}

function finish(events, format) {
  if (events.length > MAX_SUBTITLE_EVENTS) throw new Error(`The ${format} file has ${events.length} events; at most ${MAX_SUBTITLE_EVENTS} are read.`);
  if (!events.length) throw new Error(`No timed lines found in the ${format} file.`);
  return events.sort((a, b) => a.start - b.start || a.end - b.end);
}

function lines(text) {
  if (typeof text !== "string") throw new TypeError("Subtitle text must be a string.");
  if (text.length > MAX_SUBTITLE_CHARACTERS) throw new Error(`Subtitle text is limited to ${MAX_SUBTITLE_CHARACTERS} characters.`);
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
}

/** Events of a SubRip file. Blocks without a valid time line are skipped. */
export function parseSrt(text) {
  const events = [];
  let block = [];
  const flush = () => {
    const index = block.findIndex((line) => timing(line));
    if (index >= 0) {
      const { start, end } = timing(block[index]);
      const body = plainText(block.slice(index + 1).join("\n"));
      if (body && end > start) events.push({ start, end, text: body });
    }
    block = [];
  };
  for (const line of lines(text)) {
    if (line.trim() === "") flush();
    else block.push(line);
  }
  flush();
  return finish(events, "SRT");
}

/** Events of a WebVTT file. */
export function parseVtt(text) {
  const all = lines(text);
  if (!/^WEBVTT(?:$|[ \t])/.test(all[0] ?? "")) throw new Error("A WebVTT file starts with WEBVTT.");
  const events = [];
  let block = [];
  const flush = () => {
    if (block.length && !/^(NOTE|STYLE|REGION)(?:$|[ \t])/.test(block[0])) {
      const index = block.findIndex((line) => line.includes("-->"));
      const times = index >= 0 ? timing(block[index]) : null;
      if (times && times.end > times.start) {
        const raw = block.slice(index + 1).join("\n");
        const body = plainText(raw);
        const words = inlineWords(raw, times.start, times.end);
        if (body) events.push({ start: times.start, end: times.end, text: body, ...(words ? { words } : {}) });
      }
    }
    block = [];
  };
  for (const line of all.slice(1)) {
    if (line.trim() === "") flush();
    else block.push(line);
  }
  flush();
  return finish(events, "WebVTT");
}

/** "srt", "vtt" or "text" for a caption text. */
export function subtitleFormat(text) {
  const start = String(text ?? "").replace(/^\uFEFF/, "").trimStart();
  if (/^WEBVTT(?:$|[ \t\r\n])/.test(start)) return "vtt";
  if (/^\s*(?:\d+\s*\r?\n)?\s*\d{1,3}:\d\d:\d\d[,.]\d{1,3}\s+-->/.test(start)) return "srt";
  return "text";
}

/** Events of an SRT or VTT text, whichever it is. */
export function parseSubtitles(text, format = subtitleFormat(text)) {
  if (format === "srt") return parseSrt(text);
  if (format === "vtt") return parseVtt(text);
  throw new Error("This is not an SRT or WebVTT file (an SRT block has a number, then a line like 00:00:01,000 --> 00:00:03,000).");
}

function stamp(seconds, separator, hours = true) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${hours || h ? `${pad(h)}:` : ""}${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

// A cue's text without blank lines: in both formats a blank line ends the cue, so the lines
// after it would be lost.
function cueText(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim()).join("\n");
}

/** A SubRip file for events [{start, end, text}]. */
export function formatSrt(events) {
  // SubRip has no escapes; "-->" in the text could be read as a time line, so it is written "->".
  const text = (event) => cueText(event.text).replace(/-{2,}>/g, "->");
  return events.map((event, index) => `${index + 1}\n${stamp(event.start, ",")} --> ${stamp(event.end, ",")}\n${text(event)}\n`).join("\n");
}

/** A WebVTT file for events [{start, end, text}]. */
export function formatVtt(events) {
  // Escaping ">" also keeps "-->" out of the cue text, which WebVTT does not allow there.
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `WEBVTT\n\n${events.map((event) => `${stamp(event.start, ".")} --> ${stamp(event.end, ".")}\n${escape(cueText(event.text))}\n`).join("\n")}`;
}
