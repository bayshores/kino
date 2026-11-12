// type_covered: type placed behind a cut-out subject that the subject hides. cut_out gives its
// copy allowOverlap (it is transparent around the subject, so the box rules would call every
// title behind it hidden), so nothing said so when the subject covered almost all of it (study b:
// big type behind a cut-out, one letter showing). This rule judges by the subject's measured box
// (cut_out stores it on the copy as subjectBox, shares of the layer around every shown frame),
// not by the layer box and not by pixels.
import { readingTexts, sec } from "../analysis.js";
import { area, boxAt, overlapArea, roundBox } from "../model.js";

// Over this share of the text's ink inside the subject's box, for over half the time the text
// shows (both guesses: past 40% a word loses most of its letters).
export const TYPE_COVERED_SHARE = 0.4;
export const TYPE_COVERED_TIME = 0.5;

function subjectAt(cover, index) {
  const box = boxAt(cover, index), [a, b, c, d] = cover.subjectBox;
  const width = box.x1 - box.x0, height = box.y1 - box.y0;
  return { x0: box.x0 + a * width, y0: box.y0 + b * height, x1: box.x0 + c * width, y1: box.y0 + d * height };
}

export function typeCovered(model, ctx) {
  const findings = [];
  const covers = model.items.filter((item) => item.cutoutOf && Array.isArray(item.subjectBox) && item.subjectBox.length === 4);
  if (!covers.length) return findings;
  for (const text of readingTexts(model)) {
    for (const cover of covers) {
      if (cover.z <= text.z) continue;
      let shown = 0, covered = 0, worst = null, worstShare = 0;
      for (let index = 0; index < model.times.length; index += 1) {
        if (text.samples.opacity[index] < 0.5) continue;
        shown += 1;
        const ink = boxAt(text, index);
        if (cover.samples.opacity[index] < 0.5 || !area(ink)) continue;
        const share = overlapArea(ink, subjectAt(cover, index)) / area(ink);
        if (share <= TYPE_COVERED_SHARE) continue;
        covered += 1;
        if (share > worstShare) { worstShare = share; worst = index; }
      }
      if (!shown || covered <= TYPE_COVERED_TIME * shown) continue;
      // Beside the subject: on the side with more room, if the text fits there (a 4% gap, a guess).
      const ink = boxAt(text, worst), subject = subjectAt(cover, worst);
      const gap = Math.round(0.04 * model.width), width = ink.x1 - ink.x0;
      const left = subject.x0 - gap - width, right = subject.x1 + gap;
      const sides = [left >= 0 ? left : null, right + width <= model.width ? right : null];
      if (subject.x0 < model.width - subject.x1) sides.reverse();
      const x = sides.find((value) => value !== null);
      const dx = x === undefined ? null : x - ink.x0;
      const raise = `move_layers {layerIds:[${ctx.name(text)}], position:"above", referenceId:${ctx.name(cover)}}`;
      findings.push({
        rule: "type_covered", severity: "warn", itemId: text.id, otherId: cover.id,
        at: sec(model.times[worst]), bbox: roundBox(ink),
        measured: `${Math.round(worstShare * 100)}% of the type inside the subject's box for ${Math.round((100 * covered) / shown)}% of its time`,
        required: `at most ${TYPE_COVERED_SHARE * 100}% for half its time`,
        message: `The cut-out ${ctx.name(cover)} hides most of ${ctx.name(text)} behind it (subject box x ${Math.round(subject.x0)} to ${Math.round(subject.x1)}). ${dx === null ? "Raise it" : "The fix moves the type beside the subject; or raise it"}: ${raise}.`,
        fix: dx === null ? { kind: "reorder", itemId: text.id, aboveId: cover.id, auto: false }
          : { kind: "move", itemId: text.id, dx: Math.round(dx), dy: 0, auto: false, why: `moved beside the subject (${dx < 0 ? "left" : "right"})` },
      });
    }
  }
  return findings;
}
