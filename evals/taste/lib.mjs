// Pure parts of the taste harness (evals/taste/README.md): reading ffmpeg's output, choosing the
// strip times around cuts, the motion facts, and the Bradley-Terry ladder. No files, no processes,
// so tests/taste-harness.test.mjs can check them directly.

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

// ---- ffmpeg output ------------------------------------------------------------------------------

/**
 * Per-frame values from ffmpeg's `metadata=mode=print` output (scdet and signalstats):
 * [{t, score, yavg, ydif}]. Lines look like "frame:3 pts:3 pts_time:0.1" then "lavfi.scd.score=12.3".
 */
export function parseFrameMetadata(text) {
  const frames = [];
  let frame = null;
  for (const line of String(text).split("\n")) {
    const head = /pts_time:([\d.]+)/.exec(line);
    if (head) { frame = { t: Number(head[1]), score: 0, yavg: null, ydif: null }; frames.push(frame); continue; }
    if (!frame) continue;
    const pair = /lavfi\.(scd\.score|signalstats\.YAVG|signalstats\.YDIF)=([-\d.]+)/.exec(line);
    if (!pair) continue;
    const value = Number(pair[2]);
    if (pair[1] === "scd.score") frame.score = value;
    else if (pair[1] === "signalstats.YAVG") frame.yavg = value;
    else frame.ydif = value;
  }
  return frames;
}

/**
 * Cuts from per-frame scene scores: frames scoring at least `threshold` (scdet's 0 to 100 scale)
 * that are also the highest within `gap` seconds. At most `most`, the strongest kept, in time order.
 */
export function cutsFrom(frames, { threshold = 10, gap = 0.1, most = 24 } = {}) {
  const peaks = frames.filter((frame, index) => frame.t > 0.05 && frame.score >= threshold
    && frames.every((other, j) => j === index || Math.abs(other.t - frame.t) > gap || other.score < frame.score || (other.score === frame.score && j > index)));
  return peaks.sort((a, b) => b.score - a.score).slice(0, most).sort((a, b) => a.t - b.t).map((frame) => ({ t: round(frame.t), score: round(frame.score, 1) }));
}

/** Every cut, for facts.json (gap 0.06 s keeps 2-frame shots at 24 fps apart); strips use cutsFrom's top 24. */
export const allCutsFrom = (frames, options = {}) => cutsFrom(frames, { gap: 0.06, most: Infinity, ...options });

/**
 * Flash, black and hold events from per-frame luma (signalstats YAVG and YDIF, 0 to 255):
 *   flash: the picture brightens by `rise` or more in one frame and falls back by most of that within
 *     `flashSeconds` ({t, end, rise: share of 255}); a fade-up that stays bright is not a flash.
 *   black: frames at most `black` bright (limited-range black is 16), as {t, end} spans.
 *   hold: no change (YDIF under `still`) for `holdSeconds` or more, black left out, as {t, end}.
 */
export function eventsFrom(frames, { rise = 40, flashSeconds = 0.5, black = 24, still = 0.26, holdSeconds = 0.5 } = {}) {
  const flashes = [];
  for (let i = 1; i < frames.length; i += 1) {
    const before = frames[i - 1].yavg, at = frames[i].yavg;
    if (before == null || at == null || at - before < rise) continue;
    let peak = at, back = -1;
    for (let j = i + 1; j < frames.length && frames[j].t - frames[i].t <= flashSeconds + 1e-6; j += 1) {
      peak = Math.max(peak, frames[j - 1].yavg ?? 0);
      if ((frames[j].yavg ?? 255) <= before + (peak - before) / 3) { back = j; break; }
    }
    if (back < 0) continue;
    flashes.push({ t: round(frames[i].t), end: round(frames[back].t), rise: round((peak - before) / 255) });
    i = back;
  }
  const spans = (test, shortest) => {
    const found = [];
    let start = null;
    frames.forEach((frame, i) => {
      if (test(frame)) { if (start === null) start = frame.t; }
      else if (start !== null) { if (frame.t - start >= shortest - 1e-6) found.push({ t: round(start), end: round(frame.t) }); start = null; }
      if (i === frames.length - 1 && start !== null && frame.t - start >= shortest - 1e-6) found.push({ t: round(start), end: round(frame.t) });
    });
    return found;
  };
  const dark = (frame) => frame.yavg != null && frame.yavg <= black;
  return {
    flashes,
    blacks: spans(dark, 0),
    holds: spans((frame) => frame.ydif != null && frame.ydif < still && !dark(frame), holdSeconds),
  };
}

/**
 * Cuts with a flash counted once: scdet scores the way in and the way out of a flash, and luma alone
 * cannot tell a flash over a cut from one over a held shot, so the way in stays (flash: true) and
 * the cuts after it up to the flash's end go.
 */
export function outsideFlashes(cuts, flashes) {
  const inside = (cut) => flashes.find((flash) => cut.t >= flash.t - 1e-6 && cut.t <= flash.end + 1e-6);
  return cuts.flatMap((cut) => {
    const flash = inside(cut);
    if (!flash) return [cut];
    return Math.abs(cut.t - flash.t) < 1e-6 ? [{ ...cut, flash: true }] : [];
  });
}

/**
 * The strips around cuts:`side` seconds each side of every cut, joined where they overlap, each
 * with its frame times at `fps`. Returns [{from, to, cuts: [t], times: [t]}].
 */
export function stripTimes(cuts, duration, { fps = 12, side = 0.5 } = {}) {
  const spans = [];
  for (const cut of [...cuts].sort((a, b) => a.t - b.t)) {
    const from = Math.max(0, cut.t - side), to = Math.min(duration, cut.t + side);
    const last = spans.at(-1);
    if (last && from <= last.to) { last.to = Math.max(last.to, to); last.cuts.push(cut.t); }
    else spans.push({ from, to, cuts: [cut.t] });
  }
  return spans.map((span) => {
    const times = [];
    for (let n = Math.ceil(span.from * fps - 1e-6); n / fps < span.to - 1e-6; n += 1) times.push(round(n / fps, 3));
    return { from: round(span.from), to: round(span.to), cuts: span.cuts, times };
  });
}

/**
 * ffmpeg ebur128 output (stderr): {curve: [{t, m, s}] every 0.1 s, integrated, range, truePeak}.
 * Run it with `ebur128=peak=true` so the summary has a true peak.
 */
export function parseEbur128(text) {
  const curve = [];
  for (const match of String(text).matchAll(/t:\s*([\d.]+)\s+TARGET:[^M]*M:\s*([-\d.]+)\s+S:\s*([-\d.]+)/g)) {
    curve.push({ t: Number(match[1]), m: Number(match[2]), s: Number(match[3]) });
  }
  const summary = String(text).split(/Summary:/).at(-1);
  const number = (pattern) => { const found = pattern.exec(summary); return found ? Number(found[1]) : null; };
  return {
    curve,
    integrated: number(/I:\s*([-\d.]+)\s*LUFS/),
    range: number(/LRA:\s*([-\d.]+)\s*LU/),
    truePeak: number(/True peak:\s*Peak:\s*([-\d.]+)/),
  };
}

/**
 * Loudness every `step` seconds (the reading nearest each step), -70 LUFS floor: [[t, short-term,
 * momentary]]. Short-term is a 3 s window, momentary 0.4 s.
 */
export function shortTermCurve(curve, duration, step = 0.5) {
  const points = [];
  let index = 0;
  for (let t = step; t <= duration + 1e-6; t += step) {
    while (index + 1 < curve.length && Math.abs(curve[index + 1].t - t) <= Math.abs(curve[index].t - t)) index += 1;
    if (!curve.length) break;
    points.push([round(t, 1), Math.max(-70, round(curve[index].s, 1)), Math.max(-70, round(curve[index].m, 1))]);
  }
  return points;
}

/**
 * Cheap motion facts from per-frame luma (signalstats on a small copy, 0 to 255):
 * freezes (no change for `freezeSeconds` or longer) and brightness jumps away from cuts.
 */
export function motionFacts(frames, cuts, { freezeSeconds = 1, still = 0.26, jump = 5.1 } = {}) {
  const freezes = [];
  let start = null;
  const close = (end) => {
    if (start !== null && end - start >= freezeSeconds) freezes.push([round(start), round(end)]);
    start = null;
  };
  for (const frame of frames) {
    if (frame.ydif !== null && frame.ydif < still) { if (start === null) start = frame.t; }
    else close(frame.t);
  }
  close(frames.at(-1)?.t ?? 0);
  const nearCut = (t) => cuts.some((cut) => Math.abs(cut.t - t) <= 0.07);
  const jumps = [];
  for (let i = 1; i < frames.length; i += 1) {
    const change = (frames[i].yavg ?? 0) - (frames[i - 1].yavg ?? 0);
    if (Math.abs(change) >= jump && !nearCut(frames[i].t)) jumps.push({ t: round(frames[i].t), change: round(change / 255, 3) });
  }
  jumps.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const shots = [0, ...cuts.map((cut) => cut.t), frames.at(-1)?.t ?? 0].map((t, i, all) => (i ? t - all[i - 1] : null)).slice(1).filter((length) => length > 0);
  const mean = shots.reduce((sum, length) => sum + length, 0) / Math.max(1, shots.length);
  return {
    freezes,
    brightnessJumps: jumps.slice(0, 12).sort((a, b) => a.t - b.t),
    brightnessJumpCount: jumps.length,
    shotLengths: { count: shots.length, mean: round(mean), longest: round(Math.max(0, ...shots)) },
  };
}

// ---- ladder ----------------------------------------------------------------------------------------

/**
 * Bradley-Terry strengths from weighted pair results [{a, b, winner: "a"|"b"|"same", weight}]
 * (a tie is half a win each way), by Hunter's MM steps with a small prior (one tie against an
 * average player) so a player who never lost stays finite. Returns {name: rating}, where
 * rating = 400 * log10(strength) like Elo, centered on 0.
 */
export function bradleyTerry(results, { steps = 500, prior = 1 } = {}) {
  const names = [...new Set(results.flatMap((result) => [result.a, result.b]))];
  const wins = new Map(names.map((name) => [name, prior / 2]));
  const games = new Map();
  const key = (x, y) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  for (const { a, b, winner, weight = 1 } of results) {
    if (a === b) continue;
    if (winner === "a") wins.set(a, wins.get(a) + weight);
    else if (winner === "b") wins.set(b, wins.get(b) + weight);
    else { wins.set(a, wins.get(a) + weight / 2); wins.set(b, wins.get(b) + weight / 2); }
    games.set(key(a, b), (games.get(key(a, b)) ?? 0) + weight);
  }
  let strength = new Map(names.map((name) => [name, 1]));
  for (let step = 0; step < steps; step += 1) {
    const next = new Map();
    for (const name of names) {
      // The prior: `prior` games against a player of strength 1.
      let sum = prior / (strength.get(name) + 1);
      for (const [pair, count] of games) {
        const [x, y] = pair.split("\u0000");
        if (x !== name && y !== name) continue;
        const other = x === name ? y : x;
        sum += count / (strength.get(name) + strength.get(other));
      }
      next.set(name, wins.get(name) / sum);
    }
    const logMean = names.reduce((total, name) => total + Math.log(next.get(name)), 0) / Math.max(1, names.length);
    strength = new Map(names.map((name) => [name, next.get(name) / Math.exp(logMean)]));
  }
  return Object.fromEntries(names.map((name) => [name, round(400 * Math.log10(strength.get(name)), 1)]).sort((x, y) => y[1] - x[1]));
}

/** Splits owner picks in two halves by time order: even ones are judge examples, odd ones held out. */
export function splitPicks(picks) {
  const sorted = [...picks].sort((x, y) => String(x.at).localeCompare(String(y.at)));
  return { examples: sorted.filter((_, i) => i % 2 === 0), heldOut: sorted.filter((_, i) => i % 2 === 1) };
}

/** The winner's id of a pick or verdict {left, right, pick: "left"|"right"|"same"}, or null for same. */
export const pickWinner = (pick) => (pick.pick === "left" ? pick.left : pick.pick === "right" ? pick.right : null);

/**
 * How often the judge agrees with the owner's decisive picks: each held-out owner pick against the
 * judge's verdicts on the same two videos (either side order). {matched, compared, missing}.
 */
export function agreement(ownerPicks, verdicts) {
  let matched = 0, compared = 0, missing = 0;
  const same = (x, y) => (x.left === y.left && x.right === y.right) || (x.left === y.right && x.right === y.left);
  for (const pick of ownerPicks) {
    const winner = pickWinner(pick);
    if (!winner) continue;
    const verdict = verdicts.find((entry) => same(entry, pick) && pickWinner(entry));
    if (!verdict) { missing += 1; continue; }
    compared += 1;
    if (pickWinner(verdict) === winner) matched += 1;
  }
  return { matched, compared, missing };
}

/** The median of numbers (null when there are none). */
export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((x, y) => x - y);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Each speech line's loudness against the sound just before it (a rough voice-over-music level):
 * mean momentary loudness (power mean) inside the line, and in the `before` seconds before it
 * when no other line is there. curve: [{t, m}] every 0.1 s; lines: [{start, end, text}].
 * Returns [{t, text, line, before, over}] (LUFS, LU; before and over are null with no gap).
 */
export function lineLevels(curve, lines, { before = 1.5 } = {}) {
  const level = (from, to) => {
    const values = curve.filter((point) => point.t > from && point.t <= to && point.m > -70).map((point) => 10 ** (point.m / 10));
    return values.length ? round(10 * Math.log10(values.reduce((sum, value) => sum + value, 0) / values.length), 1) : null;
  };
  return lines.map((line, index) => {
    const previousEnd = index ? lines[index - 1].end : -Infinity;
    const from = line.start - before;
    const own = level(line.start + 0.2, line.end + 0.2); // momentary lags 0.2 s behind its window's middle
    const bed = from >= previousEnd && from >= 0 ? level(from + 0.2, line.start + 0.2) : null;
    return { t: line.start, text: line.text, line: own, before: bed, over: own !== null && bed !== null ? round(own - bed, 1) : null };
  });
}
