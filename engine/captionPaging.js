// Splits caption text into pages (what is on screen at one time) and times them.
//
// The limits are common timed-text rules for English subtitles:
// - 42 characters a line, two lines at most, up to 20 characters a second for adult programs;
// - at least 5/6 of a second and at most 7 seconds per event, and text usually kept to one line
//   unless it is over the character limit;
// - at least 2 frames between events at any frame rate, and gaps of either 2 frames or half a
//   second or more (shorter gaps are closed by extending the earlier event's out-time).
// The quality check's reading_time rule uses the same 20 characters a second.
//
// Three ways in:
// - pageEvents: events from an SRT or VTT file. Each event keeps its start; text that needs more
//   than two lines is split into pages that share the event's time by length.
// - pageWords: a timed transcript [{text, start, end}]. Pages follow the words.
// - pageScript: plain text and a time span. Pages are timed by reading speed.
import { round } from "./numbers.js";

export const SUBTITLE_LIMITS = Object.freeze({
  charactersPerLine: 42,
  lines: 2,
  charactersPerSecond: 20,
  minSeconds: 5 / 6,
  maxSeconds: 7,
  gapFrames: 2,
  closeGapsUnderSeconds: 0.5,
});

/** Characters as the reading_time check counts them: trimmed, each run of spaces counts as one. */
export const captionCharacters = (text) => String(text ?? "").trim().replace(/\s+/g, " ").length;

/** Seconds a page needs to be read: its characters at 20 a second, and never under 5/6 s. */
export const readingSeconds = (text, limits = SUBTITLE_LIMITS) =>
  Math.max(limits.minSeconds, captionCharacters(text) / limits.charactersPerSecond);

// Lines ending here read well as a break.
const BREAK_AFTER = /[,.;:!?…)\]"”]$/;
const SENTENCE_END = /[.!?…]["”)]?$/;
// Words that read badly at the end of a line (the next word belongs to them).
const WEAK_ENDINGS = new Set(["a", "an", "the", "to", "of", "and", "or", "but", "in", "on", "at", "for", "with", "my", "your", "our", "their", "his", "her", "its", "i"]);

function defaultFits(line, limits) {
  return captionCharacters(line) <= limits.charactersPerLine;
}

/**
 * The words as at most `limits.lines` lines (one when it fits), or null when they do not fit.
 * `fits(line)` says whether a line fits the frame (it is also held to 42 characters).
 */
export function wrapCaption(words, { fits, limits = SUBTITLE_LIMITS } = {}) {
  const ok = (line) => defaultFits(line, limits) && (!fits || fits(line));
  if (!words.length) return [];
  const whole = words.join(" ");
  if (ok(whole)) return [whole];
  if (limits.lines < 2) return null;
  let best = null;
  for (let split = 1; split < words.length; split += 1) {
    const top = words.slice(0, split).join(" ");
    const bottom = words.slice(split).join(" ");
    if (!ok(top) || !ok(bottom)) continue;
    // Balanced lines, a break after punctuation, never a weak word at the end of the top line.
    let cost = Math.abs(captionCharacters(top) - captionCharacters(bottom));
    if (BREAK_AFTER.test(words[split - 1])) cost -= 12;
    if (WEAK_ENDINGS.has(words[split - 1].toLowerCase())) cost += 15;
    if (captionCharacters(top) > captionCharacters(bottom)) cost += 1; // bottom-heavy reads better
    if (!best || cost < best.cost) best = { cost, lines: [top, bottom] };
  }
  return best?.lines ?? null;
}

/**
 * Splits text into pages of at most two lines each. Each page is its lines joined by "\n".
 * The source's own line breaks are kept when every line fits. A word too wide for a line on its
 * own is refused.
 */
export function splitIntoPages(text, { fits, limits = SUBTITLE_LIMITS } = {}) {
  const sourceLines = String(text ?? "").split("\n").map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean);
  if (!sourceLines.length) return [];
  const ok = (line) => defaultFits(line, limits) && (!fits || fits(line));
  if (sourceLines.length <= limits.lines && sourceLines.every(ok)) return [sourceLines.join("\n")];
  const words = sourceLines.join(" ").split(" ");
  for (const word of words) if (!ok(word)) throw new Error(`"${word.slice(0, 40)}" is too wide for one caption line; use a smaller fontSize or a shorter word.`);
  const pages = [];
  let from = 0;
  while (from < words.length) {
    // The most words that still fit on one page.
    let to = from + 1;
    while (to < words.length && wrapCaption(words.slice(from, to + 1), { fits, limits })) to += 1;
    // When the page is cut mid-sentence, end it at the last clause break in its second half.
    if (to < words.length && !BREAK_AFTER.test(words[to - 1])) {
      for (let cut = to - 1; cut > from + Math.floor((to - from) / 2); cut -= 1)
        if (BREAK_AFTER.test(words[cut - 1])) { to = cut; break; }
    }
    pages.push(wrapCaption(words.slice(from, to), { fits, limits }).join("\n"));
    from = to;
  }
  return pages;
}

// Applies the timing rules to pages in order. `fit` lengthens pages that are too short to read
// (up to the next page and 7 s) and closes gaps under half a second to 2 frames. Overlaps are
// always removed: a page ends 2 frames before the next one starts.
function timePages(pages, { fps, fit, limits, end: spanEnd = Infinity }) {
  const gap = limits.gapFrames / fps;
  const changes = { lengthened: 0, trimmed: 0, closed: 0 };
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const next = pages[index + 1];
    const latest = next ? next.start - gap : spanEnd;
    if (fit) {
      const wanted = Math.min(page.start + readingSeconds(page.text, limits), page.start + limits.maxSeconds, latest);
      if (wanted > page.end + 1e-9) { page.end = wanted; changes.lengthened += 1; }
      if (next && next.start - page.end > gap + 1e-9 && next.start - page.end < limits.closeGapsUnderSeconds) { page.end = latest; changes.closed += 1; }
      if (page.end - page.start > limits.maxSeconds) page.end = page.start + limits.maxSeconds;
    }
    if (page.end > latest + 1e-9 && latest > page.start) { page.end = latest; changes.trimmed += 1; }
    page.start = round(page.start);
    page.end = round(page.end);
  }
  return changes;
}

/** Pages that break the limits after timing, counted by problem, with a few examples. */
export function pageProblems(pages, { fps = 30, limits = SUBTITLE_LIMITS } = {}) {
  const gap = limits.gapFrames / fps;
  const found = { fast: [], short: [], long: [], gap: [] };
  pages.forEach((page, index) => {
    const length = page.end - page.start;
    const cps = captionCharacters(page.text) / Math.max(length, 1e-6);
    if (cps > limits.charactersPerSecond + 0.05) found.fast.push({ page: index + 1, at: page.start, cps: Math.round(cps * 10) / 10 });
    if (length < limits.minSeconds - 0.5 / fps) found.short.push({ page: index + 1, at: page.start, seconds: round(length) });
    if (length > limits.maxSeconds + 1e-6) found.long.push({ page: index + 1, at: page.start, seconds: round(length) });
    const next = pages[index + 1];
    // Times are kept to the millisecond, so a 2-frame gap may read up to 1 ms short.
    if (next && next.start - page.end < gap - 0.001) found.gap.push({ page: index + 1, at: page.end });
  });
  return found;
}

/**
 * Pages for subtitle events [{start, end, text, words?}]. timing "source" keeps every time from
 * the file (only overlaps are trimmed); "fit" also lengthens pages too short to read and closes
 * small gaps. Returns {pages: [{start, end, text, words?, event}], changes, split}.
 */
export function pageEvents(events, { fps = 30, timing = "source", fits, limits = SUBTITLE_LIMITS } = {}) {
  const pages = [];
  let split = 0;
  const gap = limits.gapFrames / fps;
  events.forEach((event, eventIndex) => {
    const texts = splitIntoPages(event.text, { fits, limits });
    if (texts.length > 1) split += 1;
    if (texts.length === 1) {
      pages.push({ start: event.start, end: event.end, text: texts[0], ...(event.words ? { words: event.words } : {}), event: eventIndex });
      return;
    }
    // Several pages share the event's time: by word times when the file has them, else by length.
    const counts = texts.map((text) => text.split(/\s+/).length);
    const total = texts.reduce((sum, text) => sum + captionCharacters(text), 0);
    let cursor = event.start;
    let wordIndex = 0;
    texts.forEach((text, index) => {
      const words = event.words?.slice(wordIndex, wordIndex + counts[index]);
      wordIndex += counts[index];
      const last = index === texts.length - 1;
      const share = (event.end - event.start) * (captionCharacters(text) / total);
      const start = index === 0 ? event.start : words?.[0]?.start ?? cursor;
      const nextWords = event.words?.[wordIndex];
      const end = last ? event.end : Math.max(start + 1 / fps, (nextWords?.start ?? start + share) - gap);
      pages.push({ start, end, text, ...(words?.length ? { words } : {}), event: eventIndex });
      cursor = end + gap;
    });
  });
  const changes = timePages(pages, { fps, fit: timing === "fit", limits });
  return { pages, changes, split };
}

/**
 * Pages for a timed transcript [{text, start, end}] (seconds). A page ends at a sentence end, before
 * a pause of half a second or more, or when two lines are full; it never lasts over 7 s.
 */
export function pageWords(words, { fps = 30, fits, limits = SUBTITLE_LIMITS } = {}) {
  const clean = words.map((word, index) => {
    const text = String(word?.text ?? word?.word ?? "").trim();
    const start = Number(word?.start);
    const end = Number(word?.end ?? start);
    if (!text || /\s/.test(text)) throw new Error(`words[${index}].text must be one word.`);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start) throw new Error(`words[${index}] needs start and end in seconds (end not before start).`);
    return { text, start, end };
  }).sort((a, b) => a.start - b.start);
  const ok = (line) => defaultFits(line, limits) && (!fits || fits(line));
  for (const word of clean) if (!ok(word.text)) throw new Error(`"${word.text.slice(0, 40)}" is too wide for one caption line.`);
  const pages = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    pages.push({ start: current[0].start, end: current.at(-1).end, text: wrapCaption(current.map((word) => word.text), { fits, limits }).join("\n"), words: current });
    current = [];
  };
  for (const word of clean) {
    if (current.length) {
      const last = current.at(-1);
      const pause = word.start - last.end;
      const tooLong = word.end - current[0].start > limits.maxSeconds;
      const full = !wrapCaption([...current, word].map((entry) => entry.text), { fits, limits });
      if (full || tooLong || pause >= limits.closeGapsUnderSeconds || (SENTENCE_END.test(last.text) && captionCharacters(current.map((entry) => entry.text).join(" ")) >= 12)) flush();
    }
    current.push(word);
  }
  flush();
  const changes = timePages(pages, { fps, fit: true, limits });
  return { pages, changes, split: 0 };
}

/**
 * Pages for plain text shown from `start` to `end` seconds. Each page gets at least its reading
 * time; spare time is shared out by length (no page over 7 s). Refuses text that cannot be read
 * in the time.
 */
export function pageScript(text, { start, end, fps = 30, fits, limits = SUBTITLE_LIMITS } = {}) {
  if (!(end > start)) throw new Error("Plain caption text needs a time span: end after start.");
  const paragraphs = String(text ?? "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const texts = paragraphs.flatMap((paragraph) => splitIntoPages(paragraph.replace(/\s*\n\s*/g, " "), { fits, limits }));
  if (!texts.length) throw new Error("The caption text is empty.");
  const gap = limits.gapFrames / fps;
  const needed = texts.map((page) => readingSeconds(page, limits));
  const available = end - start - gap * (texts.length - 1);
  const total = needed.reduce((sum, value) => sum + value, 0);
  if (total > available + 1e-6)
    throw new Error(`${texts.length} caption pages need ${round(total + gap * (texts.length - 1))}s at 20 characters a second, but the span is ${round(end - start)}s. Shorten the text or lengthen the span.`);
  const factor = available / total;
  const pages = [];
  let cursor = start;
  texts.forEach((page, index) => {
    const length = Math.min(limits.maxSeconds, needed[index] * factor);
    pages.push({ start: round(cursor), end: round(cursor + length), text: page });
    cursor += length + gap;
  });
  return { pages, changes: { lengthened: 0, trimmed: 0, closed: 0 }, split: 0 };
}
