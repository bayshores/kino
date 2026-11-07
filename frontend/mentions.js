// @mentions in comments: which names the @ list suggests, the @ being typed, putting a chosen
// name into the text, and finding the @Name mentions in a comment's text.
//
// kino has no accounts or email. A mention is a display name: the names of the people who
// have the file open now (presence) and of everyone who has commented. A comment stores the names
// it mentions in its `mentions` list (backend/comments.mjs), and the editor only stores names that
// really appear as @Name in the text. Nothing is sent to anyone. When a comment mentions the
// viewer's own display name, the editor marks it "Mentions you" (commentUnread.js).
//
// Names are matched without regard to letter case, and a mention must stand on its own: the @
// may not follow a letter or digit (so an email address is not a mention), and the name may not
// run on into more letters or digits ("@Ann" is not found in "@Anna").

// The server keeps at most 20 mentions per comment, each a name of 1 to 100 characters.
export const MAX_MENTIONS = 20;
export const MAX_MENTION_NAME = 100;
// How many names the @ list shows at once.
export const MENTION_SUGGESTIONS = 6;

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

function lower(value) {
  return value.toLocaleLowerCase();
}

// A display name fit to mention: trimmed, 1 to 100 characters, no control characters, and not
// "Guest" (the name of everyone who did not choose one). Anything else gives "".
export function mentionableName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_MENTION_NAME || CONTROL_CHARACTERS.test(name)) return "";
  if (lower(name) === "guest") return "";
  return name;
}

// The names the @ list offers: people who have the file open now first, then the authors of
// past comments, newest comment first. Each name is listed once (ignoring letter case).
export function mentionCandidates({ people = [], comments = [] } = {}) {
  const names = new Map();
  const add = (value) => {
    const name = mentionableName(value);
    if (name && !names.has(lower(name))) names.set(lower(name), name);
  };
  for (const person of people) add(person?.name);
  const newestFirst = [...comments].sort((a, b) => String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")));
  for (const comment of newestFirst) add(comment?.author);
  return [...names.values()];
}

// How many names rememberMentionNames keeps.
export const REMEMBERED_MENTION_NAMES = 200;

// The names a new comment's mentions are looked up in: `current` (the names the @ list offers
// now) first, then `remembered` (the names it offered earlier). Someone who had the file open but
// never commented leaves the list when they close the file; a name picked for them before that
// still counts as a mention when the comment is posted. Each name once, ignoring letter case, with
// the newest spelling kept; at most REMEMBERED_MENTION_NAMES names.
export function rememberMentionNames(remembered = [], current = []) {
  const names = new Map();
  for (const value of [...current, ...remembered]) {
    const name = mentionableName(value);
    if (name && !names.has(lower(name))) names.set(lower(name), name);
  }
  return [...names.values()].slice(0, REMEMBERED_MENTION_NAMES);
}

// The mention being typed at the caret: {start, end, query}, where `start` is the @ and `query`
// the text typed after it, or null when the caret is not in a mention. A query may hold spaces
// ("@Ana Li"), so names with spaces can be found; it ends at a line break or another @.
export function activeMention(text, caret) {
  const value = String(text ?? "");
  const end = Math.max(0, Math.min(Number.isFinite(caret) ? caret : value.length, value.length));
  const before = value.slice(0, end);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  if (start > 0 && WORD_CHARACTER.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  if (query.length > MAX_MENTION_NAME || /^\s/.test(query) || /[\r\n]/.test(query)) return null;
  return { start, end, query };
}

// The names that fit what was typed after @, best first: names that start with it, then names
// with a later word that starts with it. An empty query lists the first names.
export function matchMentionNames(names = [], query = "", limit = MENTION_SUGGESTIONS) {
  const typed = lower(String(query));
  if (!typed) return names.slice(0, limit);
  const starts = names.filter((name) => lower(name).startsWith(typed));
  const words = typed.includes(" ")
    ? []
    : names.filter((name) => !starts.includes(name) && lower(name).split(/\s+/).slice(1).some((word) => word.startsWith(typed)));
  return [...starts, ...words].slice(0, limit);
}

// Puts "@Name " in place of the mention being typed. Returns {text, caret}: the new text and
// where the caret goes (after the space that follows the name).
export function insertMention(text, mention, name) {
  const value = String(text ?? "");
  const after = value.slice(mention.end);
  const spacer = after.startsWith(" ") ? "" : " ";
  const next = `${value.slice(0, mention.start)}@${name}${spacer}${after}`;
  return { text: next, caret: mention.start + name.length + 2 };
}

// Every @Name in `text` for the given names: [{start, end, name}], in order. At each @ the longest
// fitting name wins, so "@Ana Lima" is Ana Lima, not Ana. `name` is spelled as in `names`.
export function findMentions(text, names = []) {
  const value = String(text ?? "");
  const choices = [...new Set(names.map(mentionableName).filter(Boolean))].sort((a, b) => b.length - a.length);
  const found = [];
  if (!choices.length) return found;
  let index = 0;
  while (index < value.length) {
    const at = value.indexOf("@", index);
    if (at < 0) break;
    if (at > 0 && WORD_CHARACTER.test(value[at - 1])) {
      index = at + 1;
      continue;
    }
    const rest = value.slice(at + 1);
    const name = choices.find(
      (choice) =>
        lower(rest.slice(0, choice.length)) === lower(choice) &&
        !(choice.length < rest.length && WORD_CHARACTER.test(rest[choice.length])),
    );
    if (!name) {
      index = at + 1;
      continue;
    }
    found.push({ start: at, end: at + 1 + name.length, name });
    index = at + 1 + name.length;
  }
  return found;
}

// The text in pieces for drawing: [{text, mention?}], where a piece with `mention` is an @Name
// to highlight. Joined together, the pieces are the text unchanged.
export function mentionSegments(text, names = []) {
  const value = String(text ?? "");
  const parts = [];
  let index = 0;
  for (const { start, end, name } of findMentions(value, names)) {
    if (start > index) parts.push({ text: value.slice(index, start) });
    parts.push({ text: value.slice(start, end), mention: name });
    index = end;
  }
  if (index < value.length || !parts.length) parts.push({ text: value.slice(index) });
  return parts;
}

// The names to save in a comment's `mentions`: each name from `names` that appears as @Name in
// the text, once, in the order they first appear, at most 20.
export function mentionsInText(text, names = []) {
  const seen = new Map();
  for (const { name } of findMentions(text, names)) if (!seen.has(lower(name))) seen.set(lower(name), name);
  return [...seen.values()].slice(0, MAX_MENTIONS);
}

// True when `comment` mentions the display name `name`: the name is in its mentions list and
// appears as @Name in its text. "Guest" and empty names are never mentioned.
export function mentionsName(comment, name) {
  const wanted = mentionableName(name);
  if (!wanted || !Array.isArray(comment?.mentions) || !comment.mentions.length) return false;
  return findMentions(comment.text, comment.mentions).some((mention) => lower(mention.name) === lower(wanted));
}
