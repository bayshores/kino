// Explainer recipes: step-list, diagram-build, connector-draw, bar-chart-grow, line-chart-draw,
// number-counter. Charts are drawn from the numbers given; nothing is made up.
import { createLayer } from "../../model.js";
import { column, paint, shapeLayer, textLayer, withAlpha } from "../build.js";
import { durationOf, easingOf } from "../tokens.js";
import { splitColumns, splitRows } from "../formats.js";
import { alignOf, formatNumber, px, styleOf } from "./common.js";

const decimalsOf = (value) => (String(value).split(".")[1]?.length ?? 0);
const stepFor = (values) => 10 ** -Math.min(4, Math.max(0, ...values.map(decimalsOf)));

/** A title across the top of `box`; returns {title, rest} where rest is the box under it. */
function titled(ctx, box, text, { share = 0.24, align = "left" } = {}) {
  if (!text) return { title: null, rest: box };
  // A long title in a narrow frame takes more of the height before it is called too long.
  const make = (part) => textLayer(ctx, { part: "title", text, role: "headline", step: "h2", box: { ...box, height: box.height * part }, align, maxLines: 2 });
  let title;
  try { title = make(share); } catch (error) { if (!error.tooLong) throw error; title = make(Math.min(0.4, share * 1.6)); }
  const used = title.height + px(ctx, 44);
  return { title, rest: { x: box.x, y: box.y + used, width: box.width, height: box.height - used } };
}

/** An arrowhead (decor) pointing right or down, `size` pixels, with its tip at (x, y). */
function arrowHead(ctx, { x, y, size, down = false }) {
  const half = Math.round(size / 2);
  const path = down ? `M0 0 L${size} 0 L${half} ${size} Z` : `M0 0 L${size} ${half} L0 ${size} Z`;
  return createLayer("path", {
    name: "Arrowhead", path, role: "decor", fill: paint(ctx.style, "accent"),
    x: Math.round(down ? x - half : x - size), y: Math.round(down ? y - size : y - half), width: size, height: size,
  });
}

/** A rounded box with an accent outline and a label centred in it. */
function node(ctx, { box, text, part }) {
  const shape = shapeLayer(ctx, { box, color: "surface", radius: px(ctx, 22), role: "decor", name: "Node", stroke: "accent", strokeWidth: Math.max(2, px(ctx, 3)) });
  const pad = px(ctx, 22);
  const label = textLayer(ctx, { part, text, role: "body", step: "h2", box: { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad }, align: "center", valign: "middle", maxLines: 3 });
  return { shape, label };
}

export const stepList = {
  name: "step-list",
  group: "explainer",
  about: "numbered steps enter one after another, each with an accent number badge",
  copy: [
    { key: "items", required: true, list: 5, min: 2, max: 48, about: "the steps, 2 to 5 short lines" },
    { key: "title", max: 48, about: "a title above the steps" },
  ],
  slots: { landscape: "A1:F6", portrait: "A1:F6", square: "A1:F6" },
  build(ctx, { copy, box, settings }) {
    const { title, rest } = titled(ctx, box, copy.title, { share: 0.22 });
    const gap = px(ctx, 22);
    const rows = splitRows(rest, copy.items.map(() => 1), gap);
    const badge = Math.min(px(ctx, 84), Math.max(...rows.map((row) => row.height)));
    const textBox = (row) => ({ x: row.x + badge + px(ctx, 30), y: row.y, width: row.width - badge - px(ctx, 30), height: row.height });
    // Every step uses the size of the one that needs the smallest.
    const first = copy.items.map((item, index) => textLayer(ctx, { part: `step-${index + 1}`, text: item, role: "body", step: "h2", box: textBox(rows[index]), valign: "middle", maxLines: 2 }));
    const size = Math.min(...first.map((layer) => layer.fontSize));
    const parts = [];
    if (title) parts.push({ part: "title", layer: title, enter: { style: "fade-up", at: 0 } });
    const motion = styleOf(ctx, settings, ["fade-up", "slide-left"]);
    copy.items.forEach((item, index) => {
      const row = rows[index];
      const text = textLayer(ctx, { part: `step-${index + 1}`, text: item, role: "body", step: "h2", size, box: textBox(row), valign: "middle", maxLines: 2 });
      const middle = text.y + text.height / 2;
      const circle = shapeLayer(ctx, { type: "ellipse", box: { x: row.x, y: middle - badge / 2, width: badge, height: badge }, color: "accent", role: "decor", name: `Badge ${index + 1}` });
      const number = textLayer(ctx, { part: `number-${index + 1}`, text: String(index + 1), role: "caption", step: "label", box: { x: row.x, y: 0, width: badge, height: badge }, align: "center", color: "bg", maxLines: 1, weight: 700 });
      number.y = Math.round(middle - number.height / 2);
      const name = index === 0 ? null : `step-${index + 1}`;
      const previous = index > 0;
      // Each step arrives once the one before it is in, so they are read in turn.
      parts.push({ part: `badge-${index + 1}`, layer: circle, enter: previous ? { style: "pop", after: index === 1 ? null : `step-${index}`, gap: 0.2, kind: "small" } : title ? { style: "pop", after: "title", gap: -0.15, kind: "small" } : { style: "pop", at: 0, kind: "small" } });
      parts.push({ part: `number-${index + 1}`, layer: number, enter: { style: "fade", with: `badge-${index + 1}`, gap: 0.06 } });
      parts.push({ part: name, layer: text, enter: { style: motion, with: `badge-${index + 1}`, gap: 0.08 } });
    });
    return { parts, assertions: [{ type: "visible_by" }, { type: "inside_frame" }, { type: "before", other: `step-${copy.items.length}` }] };
  },
};

export const diagramBuild = {
  name: "diagram-build",
  group: "explainer",
  about: "2 to 4 labelled boxes build one by one, joined by arrows that draw between them",
  copy: [
    { key: "items", required: true, list: 4, min: 2, max: 24, about: "the boxes' labels, in order" },
    { key: "title", max: 48, about: "a title above the diagram" },
  ],
  slots: { landscape: "A1:F6", portrait: "A1:F6", square: "A1:F6" },
  build(ctx, { copy, box }) {
    const { title, rest } = titled(ctx, box, copy.title, { share: 0.2 });
    const count = copy.items.length;
    const across = rest.width > rest.height * 1.2;
    const link = px(ctx, across ? 96 : 70);
    const thick = Math.max(4, px(ctx, 6));
    const head = px(ctx, 24);
    // The last box (where the flow ends) is a little larger than the others.
    const weight = (index) => (index === count - 1 ? 1.15 : 1);
    const total = count - 1 + weight(count - 1);
    const boxes = [];
    if (across) {
      const unit = (rest.width - link * (count - 1)) / total;
      const tallest = Math.min(rest.height, unit * 1.15 * 0.72);
      let x = rest.x;
      for (let index = 0; index < count; index += 1) {
        const width = unit * weight(index);
        const height = tallest * (weight(index) / 1.15);
        boxes.push({ x, y: rest.y + (rest.height - height) / 2, width, height });
        x += width + link;
      }
    } else {
      const unit = Math.min((rest.height - link * (count - 1)) / total, px(ctx, 260));
      const widest = Math.min(rest.width, px(ctx, 760) * 1.08);
      let y = rest.y + (rest.height - (unit * total + link * (count - 1))) / 2;
      for (let index = 0; index < count; index += 1) {
        const height = unit * weight(index);
        const width = widest * (index === count - 1 ? 1 : 1 / 1.08);
        boxes.push({ x: rest.x + (rest.width - width) / 2, y, width, height });
        y += height + link;
      }
    }
    const parts = [];
    if (title) parts.push({ part: "title", layer: title, enter: { style: "fade-up", at: 0 } });
    boxes.forEach((frame, index) => {
      const { shape, label } = node(ctx, { box: frame, text: copy.items[index], part: `label-${index + 1}` });
      const boxPart = index === 0 ? null : `box-${index + 1}`;
      const enter = index === 0
        ? (title ? { style: "scale", after: "title", gap: -0.15 } : { style: "scale", at: 0 })
        : { style: "scale", after: `link-${index}`, gap: -0.1 };
      parts.push({ part: boxPart, layer: shape, enter });
      parts.push({ part: `label-${index + 1}`, layer: label, enter: { style: "fade-up", with: boxPart, gap: 0.1 } });
      if (index === count - 1) return;
      const gapIn = px(ctx, 14);
      const line = across
        ? shapeLayer(ctx, { box: { x: frame.x + frame.width + gapIn, y: frame.y + frame.height / 2 - thick / 2, width: link - 2 * gapIn - head * 0.6, height: thick }, color: "accent", radius: thick / 2, role: "decor", name: "Link" })
        : shapeLayer(ctx, { box: { x: frame.x + frame.width / 2 - thick / 2, y: frame.y + frame.height + gapIn, width: thick, height: link - 2 * gapIn - head * 0.6 }, color: "accent", radius: thick / 2, role: "decor", name: "Link" });
      const tip = across
        ? arrowHead(ctx, { x: frame.x + frame.width + link - gapIn, y: frame.y + frame.height / 2, size: head })
        : arrowHead(ctx, { x: frame.x + frame.width / 2, y: frame.y + frame.height + link - gapIn, size: head, down: true });
      parts.push({ part: `link-${index + 1}`, layer: line, enter: { style: across ? "grow-x" : "grow-y", anchor: across ? "left" : "top", after: boxPart, gap: -0.05, kind: "medium" } });
      parts.push({ part: `tip-${index + 1}`, layer: tip, enter: { style: "fade", after: `link-${index + 1}`, gap: -0.08, kind: "small" } });
    });
    return { parts, assertions: [{ type: "visible_by", part: `label-${count}` }, { type: "inside_frame", part: "label-1" }] };
  },
};

export const connectorDraw = {
  name: "connector-draw",
  group: "explainer",
  about: "two labelled boxes appear, then an arrow draws from the first to the second with an optional label on it",
  copy: [
    { key: "from", required: true, max: 24, about: "the first box's label" },
    { key: "to", required: true, max: 24, about: "the second box's label" },
    { key: "label", max: 32, about: "a few words on the arrow" },
  ],
  slots: { landscape: "A2:F5", portrait: "A1:F6", square: "A1:F6" },
  build(ctx, { copy, box }) {
    const across = box.width > box.height * 1.2;
    const thick = Math.max(4, px(ctx, 6));
    const head = px(ctx, 26);
    const gapIn = px(ctx, 18);
    let first;
    let second;
    if (across) {
      const width = box.width * 0.3;
      const height = Math.min(box.height * 0.6, px(ctx, 240));
      const y = box.y + (box.height - height) / 2;
      first = { x: box.x, y, width, height };
      second = { x: box.x + box.width - width, y, width, height };
    } else {
      const width = Math.min(box.width, px(ctx, 700));
      const height = Math.min(box.height * 0.24, px(ctx, 240));
      const x = box.x + (box.width - width) / 2;
      first = { x, y: box.y, width, height };
      second = { x, y: box.y + box.height - height, width, height };
    }
    const a = node(ctx, { box: first, text: copy.from, part: "from" });
    const b = node(ctx, { box: second, text: copy.to, part: "to" });
    const line = across
      ? shapeLayer(ctx, { box: { x: first.x + first.width + gapIn, y: first.y + first.height / 2 - thick / 2, width: second.x - first.x - first.width - 2 * gapIn - head * 0.6, height: thick }, color: "accent", radius: thick / 2, role: "decor", name: "Connector" })
      : shapeLayer(ctx, { box: { x: first.x + first.width / 2 - thick / 2, y: first.y + first.height + gapIn, width: thick, height: second.y - first.y - first.height - 2 * gapIn - head * 0.6 }, color: "accent", radius: thick / 2, role: "decor", name: "Connector" });
    const tip = across
      ? arrowHead(ctx, { x: second.x - gapIn, y: second.y + second.height / 2, size: head })
      : arrowHead(ctx, { x: second.x + second.width / 2, y: second.y - gapIn, size: head, down: true });
    let label = null;
    if (copy.label) {
      label = across
        ? textLayer(ctx, { part: "label", text: copy.label, role: "caption", step: "label", box: { x: line.x, y: box.y, width: line.width, height: first.y - box.y + first.height / 2 - px(ctx, 24) }, align: "center", valign: "bottom", maxLines: 2 })
        : textLayer(ctx, { part: "label", text: copy.label, role: "caption", step: "label", box: { x: line.x + px(ctx, 28), y: line.y, width: box.x + box.width - line.x - px(ctx, 28), height: line.height }, align: "left", valign: "middle", maxLines: 3 });
    }
    return {
      parts: [
        { part: "from-box", layer: a.shape, enter: { style: "scale", at: 0 } },
        { part: "from", layer: a.label, enter: { style: "fade-up", with: "from-box", gap: 0.1 } },
        { part: "to-box", layer: b.shape, enter: { style: "scale", with: "from-box", gap: 0.18 } },
        { part: "to", layer: b.label, enter: { style: "fade-up", with: "to-box", gap: 0.1 } },
        { part: null, layer: line, enter: { style: across ? "grow-x" : "grow-y", anchor: across ? "left" : "top", after: "to-box", gap: 0.05, kind: "large" } },
        { part: "tip", layer: tip, enter: { style: "fade", after: null, gap: -0.08, kind: "small" } },
        label && { part: "label", layer: label, enter: { style: "fade-up", after: null, gap: -0.2 } },
      ].filter(Boolean),
      assertions: [{ type: "visible_by" }, { type: "before", part: "from", other: "to" }],
    };
  },
};

export const barChartGrow = {
  name: "bar-chart-grow",
  group: "explainer",
  about: "bars grow from a baseline to the values given while each value counts up above its bar",
  copy: [
    { key: "bars", required: true, list: 6, min: 2, max: 16, of: "bars", about: "2 to 6 bars, each {label, value}" },
    { key: "title", max: 48, about: "a title above the chart" },
    { key: "suffix", max: 6, about: "written after each value, such as % or k" },
  ],
  slots: { landscape: "A1:F6", portrait: "A1:F6", square: "A1:F6" },
  build(ctx, { copy, box }) {
    const bars = copy.bars.map((bar, index) => {
      if (!bar || typeof bar !== "object" || typeof bar.value !== "number" || !Number.isFinite(bar.value) || bar.value < 0)
        throw new Error(`bar-chart-grow copy.bars[${index}] must be {label, value} with a value of 0 or more.`);
      return { label: bar.label.trim(), value: bar.value };
    });
    const suffix = copy.suffix ?? "";
    const { title, rest } = titled(ctx, box, copy.title, { share: 0.2 });
    const columns = splitColumns(rest, bars.map(() => 1), px(ctx, 28));
    const names = bars.map((bar, index) => textLayer(ctx, { part: `name-${index + 1}`, text: bar.label, role: "caption", step: "label", box: { ...columns[index], height: rest.height * 0.2 }, align: "center", maxLines: 2 }));
    const valueText = (value) => `${formatNumber(value, Math.max(...bars.map((bar) => decimalsOf(bar.value))))}${suffix}`;
    const values = bars.map((bar, index) => textLayer(ctx, { part: `value-${index + 1}`, text: valueText(bar.value), role: "caption", step: "label", box: { ...columns[index], height: rest.height * 0.15 }, align: "center", maxLines: 1, weight: 700 }));
    const nameHeight = Math.max(...names.map((layer) => layer.height));
    const valueHeight = Math.max(...values.map((layer) => layer.height));
    const baseline = rest.y + rest.height - nameHeight - px(ctx, 18);
    const room = baseline - rest.y - valueHeight - px(ctx, 14);
    const top = Math.max(...bars.map((bar) => bar.value)) || 1;
    const axis = shapeLayer(ctx, { box: { x: rest.x, y: baseline, width: rest.width, height: Math.max(2, px(ctx, 3)) }, color: withAlpha(ctx.style.colors.text, 0.35), role: "decor", name: "Baseline" });
    const parts = [];
    if (title) parts.push({ part: "title", layer: title, enter: { style: "fade-up", at: 0 } });
    parts.push({ part: "axis", layer: axis, enter: title ? { style: "grow-x", after: "title", gap: -0.2, kind: "medium" } : { style: "grow-x", at: 0, kind: "medium" } });
    const extras = [];
    const easing = easingOf("move", ctx.style.feel.intensity);
    bars.forEach((bar, index) => {
      const column = columns[index];
      const width = Math.min(column.width * 0.72, px(ctx, 170));
      const height = Math.max(px(ctx, 6), Math.round((bar.value / top) * room));
      const shape = shapeLayer(ctx, { box: { x: column.x + (column.width - width) / 2, y: baseline - height, width, height }, color: bar.value === top ? "accent2" : "accent", radius: Math.min(px(ctx, 10), width / 4), role: "decor", name: `Bar ${bar.label}` });
      names[index].y = baseline + px(ctx, 18);
      const value = values[index];
      value.y = Math.round(shape.y - px(ctx, 14) - value.height);
      const barPart = index === 0 ? null : `bar-${index + 1}`;
      parts.push({ part: `name-${index + 1}`, layer: names[index], enter: { style: "fade", with: "axis", gap: 0.1 + index * 0.05 } });
      parts.push({ part: barPart, layer: shape, enter: { style: "grow-y", anchor: "bottom", with: "axis", gap: 0.2 + index * 0.1, kind: "headline", nudge: (bar.value / top) * 0.4 - 0.2 } });
      parts.push({ part: `value-${index + 1}`, layer: value, enter: { style: "fade", with: barPart, gap: 0.05, kind: "text" } });
      // The value rides up with the top of its bar, counting as it goes.
      extras.push({ part: `value-${index + 1}`, name: "ride", with: barPart, follow: barPart, animation: { name: "Ride up", kind: "custom", duration: 0, easing, unit: "layer", stagger: 0, order: "forward", from: { y: baseline - px(ctx, 14) - value.height }, to: { y: value.y } } });
      if (bar.value > 0) extras.push({ part: `value-${index + 1}`, name: "count", with: barPart, follow: barPart, animation: { name: "Count up", kind: "counter", duration: 0, easing, from: 0, to: bar.value, step: stepFor(bars.map((item) => item.value)), out: null, in: null } });
    });
    return { parts, extras, assertions: [{ type: "visible_by" }, { type: "inside_frame", part: "name-1" }] };
  },
};

export const lineChartDraw = {
  name: "line-chart-draw",
  group: "explainer",
  about: "a line draws through the values given from left to right, then a dot and the last value appear at its end",
  copy: [
    { key: "points", required: true, list: 12, min: 3, of: "numbers", about: "3 to 12 values, in order" },
    { key: "title", max: 48, about: "a title above the chart" },
    { key: "labels", list: 12, min: 2, max: 8, about: "labels under the line, one per value, such as months" },
    { key: "suffix", max: 6, about: "written after the last value, such as % or k" },
  ],
  slots: { landscape: "A1:F6", portrait: "A1:F6", square: "A1:F6" },
  build(ctx, { copy, box }) {
    const points = copy.points;
    points.forEach((value, index) => { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`line-chart-draw copy.points[${index}] must be a number.`); });
    if (copy.labels && copy.labels.length !== points.length) throw new Error(`line-chart-draw copy.labels needs one label per value (${points.length}).`);
    const { title, rest } = titled(ctx, box, copy.title, { share: 0.2 });
    const last = points[points.length - 1];
    const endText = `${formatNumber(last, Math.max(...points.map(decimalsOf)))}${copy.suffix ?? ""}`;
    const endLabel = textLayer(ctx, { part: "value", text: endText, role: "caption", step: "h2", box: { ...rest, width: Math.min(rest.width * 0.4, px(ctx, 360)), height: rest.height * 0.2 }, align: "right", maxLines: 1, weight: 700 });
    // Labels under the axis: every one when there are 6 or fewer, else the first, middle and last.
    const shown = copy.labels ? (points.length <= 6 ? points.map((_, index) => index) : [0, Math.floor((points.length - 1) / 2), points.length - 1]) : [];
    const labelWidth = Math.min(px(ctx, 180), rest.width / Math.max(1, shown.length));
    const sampleLabel = shown.length ? textLayer(ctx, { part: "labels", text: copy.labels[0], role: "caption", step: "label", box: { ...rest, width: labelWidth, height: rest.height * 0.15 }, align: "center", maxLines: 1 }) : null;
    const labelRoom = sampleLabel ? sampleLabel.height + px(ctx, 20) : 0;
    const plot = { x: rest.x + px(ctx, 12), y: rest.y + endLabel.height + px(ctx, 36), width: rest.width - px(ctx, 24), height: rest.height - endLabel.height - px(ctx, 36) - labelRoom - px(ctx, 14) };
    const low = Math.min(...points);
    const high = Math.max(...points);
    const spot = (value, index) => [
      Math.round((index / (points.length - 1)) * plot.width),
      Math.round(high === low ? plot.height / 2 : plot.height - ((value - low) / (high - low)) * plot.height),
    ];
    const spots = points.map(spot);
    const line = createLayer("path", {
      name: "Line", path: spots.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join(" "), role: "decor",
      x: plot.x, y: plot.y, width: plot.width, height: plot.height, fillEnabled: false,
      stroke: paint(ctx.style, "accent"), strokeWidth: Math.max(3, px(ctx, 8)), strokeAlign: "center",
    });
    const axis = shapeLayer(ctx, { box: { x: rest.x, y: plot.y + plot.height + px(ctx, 14), width: rest.width, height: Math.max(2, px(ctx, 3)) }, color: withAlpha(ctx.style.colors.text, 0.35), role: "decor", name: "Axis" });
    const size = px(ctx, 30);
    const [endX, endY] = spots[spots.length - 1];
    const dot = shapeLayer(ctx, { type: "ellipse", box: { x: plot.x + endX - size / 2, y: plot.y + endY - size / 2, width: size, height: size }, color: "accent2", role: "decor", name: "End dot" });
    endLabel.x = Math.round(Math.min(rest.x + rest.width - endLabel.width, plot.x + endX - endLabel.width + size / 2));
    endLabel.y = Math.round(plot.y + endY - size / 2 - px(ctx, 16) - endLabel.height);
    const parts = [];
    if (title) parts.push({ part: "title", layer: title, enter: { style: "fade-up", at: 0 } });
    parts.push({ part: "axis", layer: axis, enter: title ? { style: "grow-x", after: "title", gap: -0.2, kind: "medium" } : { style: "grow-x", at: 0, kind: "medium" } });
    shown.forEach((pointIndex, order) => {
      const label = textLayer(ctx, { part: `label-${order + 1}`, text: copy.labels[pointIndex], role: "caption", step: "label", box: { x: 0, y: axis.y + px(ctx, 20), width: labelWidth, height: sampleLabel.height * 2 }, align: "center", maxLines: 1 });
      label.x = Math.round(Math.min(rest.x + rest.width - labelWidth, Math.max(rest.x, plot.x + spots[pointIndex][0] - labelWidth / 2)));
      parts.push({ part: `label-${order + 1}`, layer: label, enter: { style: "fade", with: "axis", gap: 0.1 + order * 0.04 } });
    });
    parts.push({ part: null, layer: line, enter: { style: "wipe", with: "axis", gap: 0.25, kind: "large" } });
    parts.push({ part: "dot", layer: dot, enter: { style: "pop", after: null, gap: -0.05, kind: "small" } });
    parts.push({ part: "value", layer: endLabel, enter: { style: "fade-up", after: "dot", gap: -0.1 } });
    return { parts, assertions: [{ type: "visible_by", part: "value" }, { type: "inside_frame", part: "value" }] };
  },
};

export const numberCounter = {
  name: "number-counter",
  group: "explainer",
  about: "a large number counts up to the value given, with a label under it",
  copy: [
    { key: "value", required: true, number: true, about: "the number it counts to" },
    { key: "label", max: 48, about: "what the number is" },
    { key: "prefix", max: 4, about: "written before the number, such as $" },
    { key: "suffix", max: 6, about: "written after the number, such as % or +" },
    { key: "from", number: true, about: "the number it counts from (0 when left out)" },
  ],
  slots: { landscape: "A2:F5", portrait: "A1:F4", square: "A2:F5" },
  build(ctx, { copy, box, settings }) {
    const align = alignOf(ctx, settings, ["center", "left"]);
    const text = `${copy.prefix ?? ""}${formatNumber(copy.value)}${copy.suffix ?? ""}`;
    const number = textLayer(ctx, { part: "number", text, role: "headline", step: "display", size: Math.round(ctx.style.type.display * 1.3), box: { ...box, height: box.height * 0.55 }, align, color: "accent", maxLines: 1 });
    const label = copy.label ? textLayer(ctx, { part: "label", text: copy.label, role: "subhead", step: "body", box: { ...box, height: box.height * 0.3 }, align, maxLines: 2 }) : null;
    column(box, [{ layer: number }, label && { layer: label, gap: px(ctx, 24) }], { valign: "middle" });
    const from = copy.from ?? 0;
    const counting = from !== copy.value;
    return {
      parts: [
        { part: null, layer: number, enter: { style: styleOf(ctx, settings, ["fade-up", "scale"]), at: 0, kind: "headline" } },
        label && { part: "label", layer: label, enter: { style: "fade-up", after: null, gap: -0.2 } },
      ].filter(Boolean),
      extras: counting ? [{ part: null, name: "count", with: null, animation: { name: "Count up", kind: "counter", duration: durationOf("hero", ctx.style.feel.position), easing: easingOf("hero", 0.5), from, to: copy.value, step: stepFor([copy.value, from]), out: null, in: null } }] : [],
      assertions: [{ type: "visible_by" }, { type: "inside_frame" }],
    };
  },
};

export const EXPLAINER_RECIPES = [stepList, diagramBuild, connectorDraw, barChartGrow, lineChartDraw, numberCounter];
