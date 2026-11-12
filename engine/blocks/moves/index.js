// All moves by name: designed set pieces built from kino's own effects, one op each
// (`move {name, …}`). Each move declares the technique tags it uses (the vocabulary shared with
// check and the deck), a one-line "fits when",
// its fields and an example. The order is the order library {topic:"moves"} lists them.
import { captionWords, pushThroughType, statusLine } from "./type.js";
import { maskThroughShape, whipPan, zoomThrough } from "./transitions.js";
import { CUTS } from "./cuts.js";
import { countUp, headlineWrite, logoSettle } from "./launch.js";
import { logoMatchMove, parallaxStack, rgbSplitHit, speedLinesPhone, swipeCards, tileRing } from "./setpieces.js";
import { cardIntoDevice, liftFocus, windowPunchIn } from "./product.js";
import { drawOn } from "./lines.js";
import { perceiveInsert, voiceType } from "./footage.js";
import { pictureInPicture, splitScreen } from "./composite.js";
import { freezeShutter, maskedType } from "./freeze.js";
import { roll } from "./roll.js";
import { typeOn } from "./typing.js";
import { assemble, decode, rewrite, stream } from "./stream.js";
import { buildIn } from "./build.js";
import { carry } from "./carry.js";
import { uiPlane } from "./plane.js";
import { accentHit, lightSweep } from "./accent.js";
import { impactAccent } from "./impact.js";
import { cursor } from "./cursor.js";
import { screenRecording } from "./recording.js";
import { beatRepeat, speedRamp } from "./musicTime.js";
import { punchIn, shake } from "./camera.js";
const LIST = [captionWords, zoomThrough, whipPan, pushThroughType, logoMatchMove, speedLinesPhone, statusLine, swipeCards, rgbSplitHit, parallaxStack, maskThroughShape, tileRing, windowPunchIn, liftFocus, cardIntoDevice, headlineWrite, logoSettle, countUp, drawOn, perceiveInsert, voiceType, freezeShutter, maskedType, roll, typeOn, stream, rewrite, decode, buildIn, carry, uiPlane, accentHit, lightSweep, impactAccent, cursor, assemble, ...CUTS, screenRecording, speedRamp, beatRepeat, splitScreen, pictureInPicture, punchIn, shake];

// Old names saved projects and agents may still send, each to the move that took its place. They
// work everywhere a name does but are not listed (kicker-headline lost its label over the headline).
export const RENAMED_MOVES = Object.freeze({ "kicker-headline": "headline-write" });
const BY_NAME = Object.fromEntries(LIST.map((move) => [move.name, move]));
export const MOVES = Object.freeze({ ...BY_NAME, ...Object.fromEntries(Object.entries(RENAMED_MOVES).map(([old, name]) => [old, BY_NAME[name]])) });
export const MOVE_NAMES = Object.freeze(LIST.map((move) => move.name));

function near(name) {
  const text = String(name ?? "").toLowerCase();
  return MOVE_NAMES.filter((candidate) => candidate.includes(text) || text.includes(candidate) || candidate.split("-")[0] === text.split("-")[0]).slice(0, 3);
}

/** The move called `name`; throws a message naming near moves. */
export function moveOf(name) {
  const found = MOVES[name];
  if (found) return found;
  const suggestions = near(name);
  throw Object.assign(new Error(`Unknown move "${name}".${suggestions.length ? ` Did you mean ${suggestions.join(", ")}?` : ""} library {topic:"moves"} lists all ${MOVE_NAMES.length}.`), { suggestions });
}
