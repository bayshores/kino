// The words the dashboard shows for each approval kind (the same list as the server's
// APPROVAL_KINDS in backend/agent/dashboard.mjs, decision D3).
export const APPROVAL_WORDS = {
  "final-render": "final render over the frame limit",
  "delete-scene": "delete a scene",
  "delete-project": "archive a project",
  "overwrite-export": "overwrite an export file",
  "large-import": "import over the size limit",
  "share-link": "create a share link",
  "crew-budget": "let an agent go past its budget",
};

export const APPROVAL_KINDS = Object.keys(APPROVAL_WORDS);

// The brief's lines, in the order the agent saves and the panel shows them (the server's
// BRIEF_FIELDS in backend/agent/brief.mjs), and the words for each.
export const BRIEF_LABELS = {
  message: "message",
  plays_on: "plays on",
  made_from: "made from",
  look_sound: "look and sound",
  never: "never",
  key_moment: "key moment",
  idea: "idea",
};

export const EXPORT_FORMATS = ["mp4", "webm", "mov", "gif"];
export const EXPORT_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60];
export const DRAFT_WIDTHS = [480, 640, 960];
// The rendering settings' choices (the same lists as backend/agent/dashboard.mjs VIDEO_ENCODERS,
// VIDEO_QUALITIES and compute.framesAtOnce). "auto" comes first in each select, named after what it
// picks on this computer.
export const VIDEO_ENCODER_WORDS = {
  software: "Software (libx264)",
  videotoolbox: "VideoToolbox (Apple)",
  nvenc: "NVENC (NVIDIA)",
  amf: "AMF (AMD)",
  qsv: "Quick Sync (Intel)",
  vaapi: "VA-API (Linux)",
};
export const VIDEO_QUALITY_WORDS = { small: "Smaller file", standard: "Standard", high: "High" };
export const FRAMES_AT_ONCE = [1, 2, 3, 4, 5, 6, 7, 8, "auto"];

// The stops (direction plan §6), in the order a video meets them: the same lists as the server's
// STOP_KINDS, SKIP_FIELDS and DEFAULT_STOP_RULES in server/agent/stops.mjs. The settings save each
// as approvals["checkpoint-<kind>"] (ask or allow) and limits[<skip field>] (whole seconds).
export const STOP_KINDS = ["board", "rough", "color", "sound"];
export const STOP_WORDS = { board: "storyboard", rough: "rough cut", color: "color pass", sound: "sound pass" };
// How an answer to a stop reads on the dashboard (its read_as).
export const READ_WORDS = { approve: "approved", "approve with notes": "approved with notes", redo: "redo", "stop asking": "stop asking" };
export const STOP_SKIP_FIELDS = { board: "skipBoardUnder", rough: "skipRoughUnder", color: "skipColorUnder", sound: "skipSoundUnder" };
export const STOP_DEFAULT_SKIP = { board: 8, rough: 15, color: 15, sound: 15 };
