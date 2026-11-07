// Original motion template artwork by the kino project contributors, licensed under the GNU AGPL-3.0 (see LICENSE).
import { createDocument, createLayer, createScene, parseDocument, uid } from "./model.js";

const TEMPLATE_LICENSE = "AGPL-3.0-only";
const DURATION = 4;

export const TEMPLATE_CATALOG = Object.freeze([
  Object.freeze({
    id: "kinetic-title",
    name: "Kinetic title",
    description: "A bold editorial title with a moving accent line.",
    previewTime: 0.8,
    license: TEMPLATE_LICENSE,
  }),
  Object.freeze({
    id: "color-orbit",
    name: "Color orbit",
    description: "Bright shapes travel around a quiet central form.",
    previewTime: 1,
    license: TEMPLATE_LICENSE,
  }),
  Object.freeze({
    id: "motion-card",
    name: "Motion card",
    description: "A layered card builds into a clean graphic announcement.",
    previewTime: 0.8,
    license: TEMPLATE_LICENSE,
  }),
  Object.freeze({
    id: "lower-third",
    name: "Lower third",
    description: "A name and role slide into a simple title-safe panel.",
    previewTime: 0.9,
    license: TEMPLATE_LICENSE,
  }),
]);

function motion(name, start, duration, from, to, easing = "ease-out") {
  return { id: uid(), name, kind: "custom", start, duration, easing, from, to };
}

function text(name, value, overrides = {}) {
  return createLayer("text", {
    name,
    text: value,
    fontFamily: "Inter",
    fontSource: "",
    fontWeight: 600,
    fontStyle: "normal",
    fontSize: 48,
    fill: "#172033",
    textAlign: "left",
    verticalAlign: "top",
    ...overrides,
  });
}

function documentFor(name, scene) {
  return parseDocument(createDocument({ name, scenes: [scene] }));
}

function buildKineticTitle() {
  const title = text("Main title", "MAKE\nIT MOVE", {
    x: 150,
    y: 250,
    width: 1420,
    height: 430,
    fontSize: 150,
    fontWeight: 700,
    lineHeight: 0.94,
    fill: "#F6F4EF",
    animations: [motion("Title rise", 0, 1.2, { y: 355, opacity: 0 }, { y: 250, opacity: 1 })],
  });
  const kicker = text("Series label", "MOTION / 001", {
    x: 160,
    y: 170,
    width: 800,
    height: 50,
    fontSize: 26,
    fontWeight: 500,
    fill: "#9DA8BB",
  });
  const rule = createLayer("rectangle", {
    name: "Coral accent",
    x: 160,
    y: 760,
    width: 520,
    height: 14,
    radius: 7,
    cornerRadii: [7, 7, 7, 7],
    fill: "#FF715B",
    animations: [motion("Accent extends", 0.1, 1.3, { width: 70, opacity: 0.5 }, { width: 520, opacity: 1 })],
  });
  const footer = text("Footer", "AN ORIGINAL MOTION STUDY", {
    x: 160,
    y: 850,
    width: 840,
    height: 52,
    fontSize: 24,
    fontWeight: 400,
    fill: "#9DA8BB",
  });
  return documentFor("Kinetic title", createScene({
    name: "Kinetic title",
    width: 1920,
    height: 1080,
    duration: DURATION,
    background: "#111625",
    layers: [kicker, title, rule, footer],
  }));
}

function buildColorOrbit() {
  const label = text("Orbit label", "COLOR\nIN MOTION", {
    x: 135,
    y: 110,
    width: 680,
    height: 210,
    fontSize: 74,
    fontWeight: 700,
    lineHeight: 0.95,
    fill: "#17223B",
    animations: [motion("Label appears", 0, 0.9, { opacity: 0, y: 145 }, { opacity: 1, y: 110 })],
  });
  const orbit = createLayer("ellipse", {
    name: "Orbit track",
    x: 710,
    y: 250,
    width: 500,
    height: 500,
    donut: 0.035,
    fill: "#17223B",
  });
  const center = createLayer("ellipse", {
    name: "Orbit center",
    x: 850,
    y: 390,
    width: 220,
    height: 220,
    fill: "#17223B",
  });
  const coral = createLayer("ellipse", {
    name: "Coral satellite",
    x: 325,
    y: 410,
    width: 150,
    height: 150,
    fill: "#FF6B5E",
    animations: [motion("Coral satellite travels", 0, 1.8, { x: 325, y: 410 }, { x: 780, y: 200 }, "linear")],
  });
  const yellow = createLayer("ellipse", {
    name: "Golden satellite",
    x: 1390,
    y: 520,
    width: 96,
    height: 96,
    fill: "#F3B83E",
    animations: [motion("Golden satellite travels", 0.1, 1.7, { x: 1390, y: 520 }, { x: 1110, y: 720 }, "linear")],
  });
  const blue = createLayer("rectangle", {
    name: "Blue marker",
    x: 1230,
    y: 230,
    width: 88,
    height: 88,
    rotation: -18,
    cornerRadii: [18, 18, 18, 18],
    fill: "#5976E8",
    animations: [motion("Blue marker turns", 0, 1.5, { rotation: -18, scaleX: 0.7, scaleY: 0.7 }, { rotation: 28, scaleX: 1, scaleY: 1 })],
  });
  const footer = text("Orbit footer", "A STUDY IN SIMPLE SHAPES", {
    x: 140,
    y: 900,
    width: 720,
    height: 44,
    fontSize: 22,
    fontWeight: 500,
    fill: "#657087",
  });
  return documentFor("Color orbit", createScene({
    name: "Color orbit",
    width: 1920,
    height: 1080,
    duration: DURATION,
    background: "#F4F0E6",
    layers: [label, orbit, center, coral, yellow, blue, footer],
  }));
}

function buildMotionCard() {
  const card = createLayer("rectangle", {
    name: "Paper card",
    x: 215,
    y: 170,
    width: 1490,
    height: 740,
    cornerRadii: [48, 48, 48, 48],
    fill: "#FBFAF7",
    shadow: { x: 0, y: 18, blur: 42, color: "#1B2C3A26" },
    animations: [motion("Card settles", 0, 1.1, { y: 270, opacity: 0 }, { y: 170, opacity: 1 })],
  });
  const eyebrow = text("Card eyebrow", "FIELD NOTES  /  2026", {
    x: 330,
    y: 285,
    width: 690,
    height: 44,
    fontSize: 24,
    fontWeight: 500,
    fill: "#6C7788",
  });
  const title = text("Card title", "Ideas in\nmotion.", {
    x: 320,
    y: 370,
    width: 920,
    height: 300,
    fontSize: 112,
    fontWeight: 700,
    lineHeight: 0.94,
    fill: "#1A2938",
    animations: [motion("Card title lifts", 0.15, 1.1, { y: 455, opacity: 0 }, { y: 370, opacity: 1 })],
  });
  const accent = createLayer("rectangle", {
    name: "Yellow card accent",
    x: 1390,
    y: 300,
    width: 190,
    height: 190,
    cornerRadii: [36, 36, 36, 36],
    rotation: 12,
    fill: "#F3BC45",
    animations: [motion("Accent pops", 0.05, 0.9, { rotation: -10, scaleX: 0.4, scaleY: 0.4, opacity: 0 }, { rotation: 12, scaleX: 1, scaleY: 1, opacity: 1 })],
  });
  const dot = createLayer("ellipse", {
    name: "Coral dot",
    x: 1425,
    y: 655,
    width: 72,
    height: 72,
    fill: "#FF725B",
    animations: [motion("Dot arrives", 0.25, 0.8, { x: 1510, opacity: 0 }, { x: 1425, opacity: 1 })],
  });
  const footer = text("Card footer", "FORM  /  COLOR  /  TIMING", {
    x: 330,
    y: 760,
    width: 800,
    height: 44,
    fontSize: 22,
    fontWeight: 500,
    fill: "#788395",
  });
  return documentFor("Motion card", createScene({
    name: "Motion card",
    width: 1920,
    height: 1080,
    duration: DURATION,
    background: "#DCE8EC",
    layers: [card, eyebrow, title, accent, dot, footer],
  }));
}

function buildLowerThird() {
  const caption = createLayer("rectangle", {
    name: "Caption panel",
    x: 145,
    y: 700,
    width: 940,
    height: 245,
    cornerRadii: [24, 24, 24, 24],
    fill: "#F8F5EF",
    animations: [motion("Panel slides in", 0, 1.1, { x: -770, opacity: 0 }, { x: 145, opacity: 1 })],
  });
  const stripe = createLayer("rectangle", {
    name: "Panel accent",
    x: 145,
    y: 700,
    width: 16,
    height: 245,
    cornerRadii: [8, 0, 0, 8],
    fill: "#FF725B",
    animations: [motion("Accent follows panel", 0, 1.1, { x: -770, opacity: 0 }, { x: 145, opacity: 1 })],
  });
  const name = text("Name", "YOUR NAME", {
    x: 205,
    y: 745,
    width: 780,
    height: 92,
    fontSize: 68,
    fontWeight: 700,
    fill: "#17263A",
    animations: [motion("Name reveals", 0.1, 0.9, { x: 280, opacity: 0 }, { x: 205, opacity: 1 })],
  });
  const role = text("Role", "ROLE / ORGANIZATION", {
    x: 208,
    y: 842,
    width: 760,
    height: 52,
    fontSize: 25,
    fontWeight: 500,
    fill: "#657185",
    animations: [motion("Role follows name", 0.22, 0.8, { x: 280, opacity: 0 }, { x: 208, opacity: 1 })],
  });
  const heading = text("Project label", "ON SCREEN  /  LOWER THIRD", {
    x: 150,
    y: 92,
    width: 900,
    height: 54,
    fontSize: 26,
    fontWeight: 500,
    fill: "#A8B4C4",
  });
  const marker = createLayer("ellipse", {
    name: "Floating marker",
    x: 1530,
    y: 180,
    width: 190,
    height: 190,
    fill: "#FF725B",
    animations: [motion("Marker scales", 0.1, 1, { scaleX: 0.65, scaleY: 0.65, opacity: 0.4 }, { scaleX: 1, scaleY: 1, opacity: 1 })],
  });
  const blue = createLayer("rectangle", {
    name: "Blue marker",
    x: 1410,
    y: 470,
    width: 70,
    height: 70,
    rotation: 18,
    cornerRadii: [14, 14, 14, 14],
    fill: "#6C8DE8",
    animations: [motion("Blue marker turns", 0, 1.2, { rotation: -12, x: 1440 }, { rotation: 18, x: 1410 })],
  });
  return documentFor("Lower third", createScene({
    name: "Lower third",
    width: 1920,
    height: 1080,
    duration: DURATION,
    background: "#17263A",
    layers: [heading, marker, blue, caption, stripe, name, role],
  }));
}

const BUILDERS = new Map([
  ["kinetic-title", buildKineticTitle],
  ["color-orbit", buildColorOrbit],
  ["motion-card", buildMotionCard],
  ["lower-third", buildLowerThird],
]);

export function createTemplateDocument(id) {
  const build = BUILDERS.get(id);
  if (!build) throw new Error("Choose an available kino template.");
  return build();
}
