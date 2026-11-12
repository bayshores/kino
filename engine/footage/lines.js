// Which spoken lines of the clips compose {footage} keeps heard (plan.js). With no voice-over the
// clips' own lines play by default: run 6 and the five runs before it muted every clip and the
// owner named the missing dialogue each time (.scratch/ceiling/trace-code.md section 3). A line
// plays at its clip's volume for its span with short fades, the music ducks under it and it gets
// a caption (ops.js does all three for a speech shot).
//
//   lines   left out: up to one line per LINE_EVERY seconds of video
//           a number: up to that many; a list of line texts: those lines; false: none
//
// Ranking: the moment's own score (moments.js), plus a short line said clearly, a line repeated
// (in itself or elsewhere in the clips), an exclaimed line, and words it shares with the
// person's own message (a saved source).

// One kept line per this many seconds. A guess: the three directors who built the same 18 s ask
// by hand kept 1, 4 and 5 lines (.scratch/ceiling/{a,b,c}/result.md); 6 s gives 3 in 18 s.
export const LINE_EVERY = 6;
// A ranked line plays when it scores this much (plan.js SPEECH_BAR, the bar body speech had).
export const LINE_BAR = 60;
// Bonuses (guesses, sized against SPEECH_BAR): a 2 or 3 word line said clearly (every word heard
// at 0.6 or more) gets SHORT, so a short famous line scoring 45 to 59 can pass the bar; a repeat
// gets REPEAT; "!" gets LOUD (the transcript has no loudness a word); each message word MESSAGE.
const SHORT = 15;
const REPEAT = 15;
const LOUD = 5;
const MESSAGE = 10;
const MESSAGE_MOST = 30;
const STOP = new Set("the and you are for was this that with have not but what all can her his him she they them out just get got its it's i'm".split(" "));

const key = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const tokens = (text) => (String(text ?? "").toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((token) => token.replaceAll("'", ""));

/** True when `text` names the line `moment` says (letters only, either one inside the other). */
export function namesLine(moment, text) {
  const wanted = key(text);
  const said = key(moment.text);
  return wanted.length >= 2 && (said.includes(wanted) || (wanted.includes(said) && said.length >= 4));
}

/**
 * Each speech moment with its line score and why: [{moment, score, why}], best first.
 * `all`: every speech moment of the clips (for repeats); `message`: the person's words or "".
 */
export function rankLines(moments, { all = moments, message = "" } = {}) {
  const asked = new Set(tokens(message).filter((token) => token.length >= 3 && !STOP.has(token)));
  const counts = new Map();
  for (const moment of all) counts.set(key(moment.text), (counts.get(key(moment.text)) ?? 0) + 1);
  return moments.map((moment) => {
    const words = moment.words ?? [];
    const own = tokens(moment.text);
    const why = [];
    let score = moment.score;
    if (words.length >= 2 && words.length <= 3 && words.every((word) => !word.unclear && (word.p ?? 1) >= 0.6)) { score += SHORT; why.push("short and clear"); }
    if (counts.get(key(moment.text)) > 1 || new Set(own).size < own.length) { score += REPEAT; why.push("repeated"); }
    if (/!/.test(moment.text)) { score += LOUD; why.push("exclaimed"); }
    const shared = [...new Set(own)].filter((token) => asked.has(token)).length;
    if (shared) { score += Math.min(MESSAGE_MOST, shared * MESSAGE); why.push(`${shared} of your words`); }
    return { moment, score, why };
  }).sort((a, b) => b.score - a.score || a.moment.in - b.moment.in);
}

/**
 * The speech moments to keep heard, and the ones left out: {chosen, left, missing, count}.
 * `option` is compose's lines (undefined, a number, a list of texts, or false); `count` from the
 * video's length; `opening` counts as one kept line when it is speech. Speech also stays inside
 * `budget` seconds (plan.js SPEECH_SHARE).
 */
export function pickLines(candidates, { option, duration, opening = null, budget = Infinity, all = candidates, message = "", least = 0 }) {
  // A sound tag ("coughs*", "[music]", "(laughs)") is no line: on the run 6 copy the only lines
  // left out were three such tags.
  const said = (text) => /\p{L}/u.test(String(text).replace(/\[[^\]]*\]|\([^)]*\)|\S*\*\S*/g, ""));
  const ranked = rankLines(candidates.filter((moment) => said(moment.text)), { all, message });
  if (option === false) return { chosen: [], left: ranked, missing: [], count: 0 };
  const listed = Array.isArray(option);
  // `least`: the lines the old bar kept (score 60+, 3+ words), so a talking edit keeps as many as before.
  const count = listed ? option.length : Number.isInteger(option) ? option : Math.max(1, Math.floor(duration / LINE_EVERY), least);
  const room = Math.max(0, count - (opening?.kind === "speech" ? 1 : 0));
  const chosen = [];
  const missing = [];
  let spoken = 0;
  const take = (entry) => {
    const length = entry.moment.out - entry.moment.in;
    if (chosen.includes(entry) || spoken + length > budget) return false;
    chosen.push(entry);
    spoken += length;
    return true;
  };
  if (listed) {
    for (const text of option) {
      const entry = ranked.find((item) => namesLine(item.moment, text));
      if (!entry || !take(entry)) missing.push(text);
    }
  } else {
    for (const entry of ranked) {
      if (chosen.length >= room) break;
      if (entry.score >= LINE_BAR) take(entry);
    }
  }
  return { chosen: chosen.map((entry) => ({ ...entry })), left: ranked.filter((entry) => !chosen.includes(entry)), missing, count };
}
