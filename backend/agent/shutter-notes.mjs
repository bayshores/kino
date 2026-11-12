// The edit receipt's word on motion blur (the project's shutter, update_project {shutterAngle}):
// what turning it on does, and, while it is off, one line when the edit made a fast move whose
// smear look would not show (GAPS item 9: a whip turn and a wheel pop drawn sharp).
import { LOOK_MOTION_SAMPLES } from "../../engine/previewBlur.js";

// A move under this long is fast by design (a whip turn, a punch, a pop). 0.2 s is the task's line:
// a guess near 4 to 6 frames, where a turn reads as a smear in the references, not as motion.
export const FAST_MOVE_SECONDS = 0.2;
// Moves that are a fast smear whatever their length.
const FAST_MOVES = new Set(["whip-pan"]);
// What a layer's own move changes; an opacity or color change does not smear.
const MOVING_KEYS = ["x", "y", "rotation", "scale", "scaleX", "scaleY"];

function movesFast(animation) {
  if (!animation || !(Number(animation.duration) < FAST_MOVE_SECONDS)) return false;
  if (["whip", "spin"].includes(animation.preset?.id)) return true;
  const from = animation.from ?? {}, to = animation.to ?? {};
  return MOVING_KEYS.some((key) => to[key] !== undefined && from[key] !== undefined && to[key] !== from[key]);
}

/**
 * The note for this edit, or null. `before` and `after` are the documents, `operations` the edit's
 * translated operations and `createdIds` the ids it created (animations among them).
 */
export function shutterNote(before, after, operations, createdIds = []) {
  const angle = after?.shutterAngle;
  if (angle > 0 && angle !== before?.shutterAngle)
    return `shutterAngle ${angle}: look frames, sheets and draft renders draw motion blur, up to ${LOOK_MOTION_SAMPLES} moments a moving frame (a draft takes render options {motionSamples}); a final uses this shutter too`;
  if (angle > 0 || angle === 0) return null;
  const created = new Set(createdIds);
  const fastMove = operations.some((operation) => operation?.type === "move" && !operation.remove && FAST_MOVES.has(operation.name));
  const fastAnimation = !fastMove && (after?.scenes ?? []).some((scene) => (scene.layers ?? []).some((layer) =>
    (layer.animations ?? []).some((animation) => created.has(animation.id) && movesFast(animation))));
  return fastMove || fastAnimation ? "motion blur is off: project {shutterAngle:180} shows the smear (update_project {properties:{shutterAngle:180}})" : null;
}
