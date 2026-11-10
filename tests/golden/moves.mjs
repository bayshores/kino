// Golden-frame fixtures for moves (engine/blocks/moves/): each document is built by running the move
// exactly as the move op does (runMove, then placeMove) on plain shapes, so a change to what a
// move makes shows up as changed frames. Shots are gradient rectangles; the tile ring plays the
// generated golden video (tests/golden/media.mjs). Frames land on the parts quality
// control once found broken in a real edit: the title's hold and its push into a letter, karaoke captions, captions beside a
// phone, a push that ends with a phone's screen filling the frame, and the tile ring's field.
import { createDocument, createLayer, createScene, parseDocument } from "../../engine/model.js";
import { styleFor } from "../../engine/blocks/looks.js";
import { placeMove, readMoveInput, runMove } from "../../engine/blocks/move.js";
import { MOVES } from "../../engine/blocks/moves/index.js";
import { fonts } from "./render.mjs";

const MAIN = "main";
const FRAME = { width: 960, height: 540 };
const linear = (angle, ...colors) => ({ type: "linear", angle, stops: colors.map((color, index) => ({ offset: index / (colors.length - 1), color })) });
const shot = (id, fill) => createLayer("rectangle", { id, name: id, x: 0, y: 0, ...FRAME, fill });

/** Runs moves in order on a scene of `layers` and returns the golden fixture. */
function moveFixture(name, { layers, moves, duration = 4, times, media = false, background = "#0B0B0D" }) {
  const scene = createScene({ id: MAIN, name, ...FRAME, duration, background, layers });
  // Goldens pin the look: kino has no default look (a move with none gets a seeded one).
  const style = styleFor({ look: "crisp", frame: FRAME });
  for (const { move, id, at, dur = null, ...fields } of moves) {
    const definition = MOVES[move];
    const made = runMove(definition, { id, input: readMoveInput(definition, fields), scene, style, fonts, start: at, dur, media: () => { throw new Error("no pictures"); } });
    placeMove(scene, { id, name: move, settings: { at, ...(dur === null ? {} : { dur }), look: "crisp", ...fields } }, made);
  }
  const document = parseDocument(createDocument({ id: `golden-${name}`, name, scenes: [scene] }));
  return { name, document, times, width: 480, ...(media ? { media } : {}) };
}

function pushThroughType() {
  return moveFixture("move-push-through-type", {
    layers: [shot("next", linear(135, "#2F6FDF", "#3AA675", "#F5B700"))],
    moves: [{ move: "push-through-type", id: "title", text: "pip.", next: "next", at: 0.2, dur: 2.6 }],
    times: [1.1, 2.15, 2.6],
  });
}

function captionsBesidePhone() {
  const phone = createLayer("rectangle", { id: "phone", name: "phone", x: 600, y: 30, width: 230, height: 480, radius: 36, fill: "#E8E4DC" });
  return moveFixture("move-captions-beside-phone", {
    layers: [shot("street", linear(90, "#9CC3E0", "#EEF2F4")), phone],
    moves: [{ move: "caption-words", id: "said", at: 0.2, avoid: ["phone"], words: [{ text: "sure.", at: 0.2 }, { text: "where would", at: 0.9 }, { text: "you like to go?", at: 1.3, end: 2.6 }] }],
    times: [0.6, 1.6],
  });
}

// Karaoke captions: at 1.36 s the second caption "where would you like to go?" is on ("sure." was
// its own caption and is gone). "you" is being said (accent, still scaling up from 92%), "where
// would" sits at 70%, and "like to go?" waits in place at 70% and 92%, so the line stays centered.
function karaokeCaptions() {
  return moveFixture("move-karaoke-captions", {
    layers: [shot("street", linear(90, "#3B4A5C", "#9CC3E0"))],
    moves: [{ move: "caption-words", id: "said", at: 0.2, highlight: "active", entrance: "pop", energy: "calm",
      words: [{ text: "sure.", at: 0.2 }, { text: "where would", at: 0.9 }, { text: "you", at: 1.3 }, { text: "like to go?", at: 1.6, end: 2.6 }] }],
    duration: 3,
    times: [1.36],
  });
}

function zoomIntoScreen() {
  const group = createLayer("group", { id: "phone", name: "phone", x: 600, y: 30, width: 234, height: 480 });
  const body = createLayer("rectangle", { id: "phone-body", name: "phone-body", parentId: "phone", x: 0, y: 0, width: 234, height: 480, radius: 36, fill: "#C9CCD0" });
  const screen = createLayer("rectangle", { id: "phone-screen", name: "phone-screen", parentId: "phone", x: 10, y: 8, width: 214, height: 464, radius: 28, fill: linear(90, "#121317", "#FF4D94", "#121317") });
  return moveFixture("move-zoom-target", {
    layers: [shot("street", linear(90, "#59606B", "#C9CCD0")), group, body, screen],
    moves: [{ move: "zoom-through", id: "into", from: "phone", at: 0.5, dur: 0.8, target: { layer: "phone-screen", rect: [0, 40, 100, 20] } }],
    duration: 2,
    // 1.2: the eased-in push is fast and blurred; 1.5: landed, sharp.
    times: [1.2, 1.5],
  });
}

function tileRing() {
  const video = createLayer("video", { id: "clip", name: "clip", x: 0, y: 0, ...FRAME, src: "/api/media/golden.mp4", mediaSourceDuration: 2, mediaFreeze: "both" });
  return moveFixture("move-tile-ring", {
    layers: [video],
    moves: [{ move: "tile-ring", id: "ring", layer: "clip", at: 0.2, dur: 2.4, spin: -60 }],
    duration: 3,
    times: [1.2, 2.55],
    media: true,
  });
}

// The eight short cuts (engine/blocks/moves/cuts.js) on one sheet: each between two striped shots,
// starting at 0.5 s, drawn at its peak (the blur, flash, wash, bands, split, tilt or wipe at its
// strongest) and tiled 4 by 2 at 240 px a tile, so one PNG shows them all.
const CUT_PEAKS = { "zoom-blur": 0.68, flash: 0.6, "light-leak": 0.77, slice: 0.7, glitch: 0.64, "blur-dissolve": 0.62, "card-tilt": 0.77, "shape-wipe": 0.8 };
function cutTransitions() {
  const parts = Object.entries(CUT_PEAKS).map(([move, time]) => ({ ...moveFixture(`cut-${move}`, {
    layers: [shot("shot-a", linear(90, ...Array(9).fill(["#2F6FDF", "#EDEFF2"]).flat())), shot("shot-b", linear(0, ...Array(6).fill(["#E4572E", "#F5B700"]).flat()))],
    moves: [{ move, id: "cut", from: "shot-a", to: "shot-b", at: 0.5 }],
    duration: 1.5, times: [time],
  }), width: 240, time }));
  return { name: "move-cut-transitions", sheet: parts, columns: 4, times: ["peaks"] };
}

export function moveScenes() {
  return [pushThroughType(), captionsBesidePhone(), karaokeCaptions(), zoomIntoScreen(), tileRing(), cutTransitions()];
}
