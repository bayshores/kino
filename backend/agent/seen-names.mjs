// What an agent sees in a reference ("glow", "subtitles", "speed ramp", "shake") turned into the
// kino names that make it: effects, moves and ops, each with the call that reads its rules.
// library {topic:"search"} puts these lines first; the guide topics that mention the words follow.
import { EFFECTS } from "../../engine/effects/catalog.js";
import { MOVE_NAMES } from "../../engine/blocks/moves/index.js";

// The Generate effects (particles made inside kino), the order an agent most often needs them.
const PARTICLE_LOOKS = ["embers", "sparks", "bokeh", "dust", "snow", "rain", "fog", "streaks", "light-leaks"];

// Plain words for a look and the kino names that make it. Keys are lower case, words joined by
// one space. A key of several words matches where the query holds those words in a row; a key of
// one word matches the whole query or one of its words, except a LOOSE word.
const SEEN_AS = {
  glow: ["glow", "accent-hit"], bloom: ["glow", "overexpose", "light-shape"], halo: ["light-shape", "glow"], neon: ["glow", "outline_text", "rim-light"], halation: ["scene-background", "glow"],
  // All nine particle looks, each with its WHEN line (GAPS 23: a director saw "particles sparks" and used only sparks).
  particles: PARTICLE_LOOKS, particle: PARTICLE_LOOKS, "particle effects": PARTICLE_LOOKS, "particle overlay": PARTICLE_LOOKS, sparkles: ["sparks", "embers"],
  ash: ["embers", "dust"], fire: ["embers", "sparks"], smoke: ["fog"], haze: ["scene-background", "fog"],
  subtitles: ["add_captions", "caption-words"], subtitle: ["add_captions", "caption-words"], captions: ["add_captions", "caption-words"],
  caption: ["add_captions", "caption-words"], lyrics: ["add_captions", "caption-words"],
  "cut out": ["cut_out"], cutout: ["cut_out"], "crisp cutout": ["cut_out"], "cutout edge": ["cut_out"], "hard matte edge": ["cut_out"], silhouette: ["cut_out"], matte: ["cut_out"], "background removal": ["cut_out"], "remove background": ["cut_out"], "sharp cutout": ["cut_out"],
  // A clip's own line heard over the song, or the song cut out for it (keep_line dropout).
  "line over music": ["keep_line", "duck_audio"], "dialogue over music": ["keep_line", "duck_audio"], dropout: ["keep_line"], "music comes back late": ["keep_line"], "music returns on the beat": ["keep_line"], "music drops out": ["keep_line"], "music cuts out": ["keep_line"],
  // A line in another language, kept as said with its English (look source prints both).
  translation: ["keep_line", "add_captions"], "foreign language": ["keep_line"], "english subtitles": ["keep_line", "add_captions"], "original language": ["keep_line"],
  // A made element that comes back at chosen times, a little different (duplicate_layers at + vary).
  motif: ["duplicate_layers"], callback: ["duplicate_layers"], "comes back": ["duplicate_layers"], recurring: ["duplicate_layers"], "returning element": ["duplicate_layers"],
  // An added sound on a visible action (a whoosh on a whip, a hit on an impact), leveled under the song.
  "sound effects": ["place_sounds"], "sound effect": ["place_sounds"], sfx: ["place_sounds"], whoosh: ["place_sounds"], swoosh: ["place_sounds"], foley: ["place_sounds"], "sound design": ["place_sounds"],
  "speed ramp": ["speed-ramp", "clip-speed"], ramp: ["speed-ramp", "clip-speed"], "slow motion": ["speed-ramp", "clip-speed"],
  "slow mo": ["speed-ramp", "clip-speed"], slowmo: ["speed-ramp", "clip-speed"], "time remap": ["speed-ramp", "clip-speed"],
  "fast forward": ["clip-speed"], reverse: ["clip-speed"],
  shake: ["shake", "impact-accent", "wiggle"], "camera shake": ["shake", "impact-accent", "wiggle"], handheld: ["shake"], jolt: ["shake", "impact-accent"], hit: ["impact-accent", "punch-in"], "impact hit": ["impact-accent"], "drop hit": ["impact-accent"],
  // A flash or wash of light over a shot is overexpose; over a plate or the frame, a gradient fill (layer-style) (GAPS: directors built flat rectangles).
  flash: ["impact-accent", "flash", "overexpose", "layer-style"], strobe: ["impact-accent"], "white flash": ["overexpose", "flash", "impact-accent", "layer-style"], "flash frame": ["flash", "impact-accent"], "flat frame": ["flash"], "white frame": ["flash"], "one frame flash": ["flash"], "single frame flash": ["flash"],
  overexposed: ["overexpose"], overexposure: ["overexpose"], "burn out": ["overexpose"], "blown out": ["overexpose"], wash: ["overexpose", "layer-style"], "white out": ["overexpose"], exposure: ["overexpose", "color-grade"],
  "light wash": ["overexpose", "layer-style"], "color wash": ["overexpose", "layer-style", "light-leaks"], "gradient wash": ["layer-style", "overexpose"], gradient: ["layer-style", "scene-background"], "gradient fill": ["layer-style"],
  "light rays": ["light-rays"], "god rays": ["light-rays"], rays: ["light-rays"], beams: ["light-rays"],
  "lens flare": ["lens-flare"], flare: ["lens-flare", "light-shape"], "light leak": ["light-leaks", "light-leak"],
  // Made lights (light-shape): plate, streak and ring words the recreate directors used (GAPS item 4).
  "glow plate": ["light-shape"], "light bar": ["light-shape"],
  "ring light": ["light-shape"], "light ring": ["light-shape"], "lit plate": ["light-shape"],
  "color grade": ["color_filter", "color-grade", "color-wheels"], grade: ["color_filter", "color-grade", "color-wheels"],
  grading: ["color_filter", "color-grade"],
  // Plain words for the settings of color-grade and hue-saturation (the ceiling studies guessed
  // "color-correct" and "brightness" as effect names).
  "color correct": ["color-grade", "color-wheels", "hue-saturation"], "color correction": ["color-grade", "color-wheels", "hue-saturation"],
  correction: ["color-grade", "color-wheels"], brightness: ["color-grade", "color-wheels"], brighten: ["color-grade", "overexpose"], darken: ["color-grade", "vignette"],
  contrast: ["color-grade", "curves"], saturation: ["hue-saturation", "color-grade"], saturate: ["hue-saturation"], desaturate: ["hue-saturation"],
  levels: ["curves", "color-grade"], gamma: ["color-wheels", "curves"],
  tint: ["white-balance", "color_filter", "hue-saturation"],
  "green tint": ["white-balance", "color_filter", "color-wheels"], green: ["white-balance", "color-wheels", "hue-saturation"], desaturated: ["hue-saturation", "keep-color"], "black and white": ["hue-saturation", "keep-color"],
  repeat: ["beat-repeat"], stutter: ["beat-repeat"], "replay on beats": ["beat-repeat"], "repeat on beats": ["beat-repeat"], echo: ["beat-repeat", "inward-echoes"],
  // Slice displacement: the glitch move's blocks (bands torn sideways), the glitch preset's slices, and smear (datamosh drag).
  glitch: ["glitch", "smear", "preset-glitch", "rgb-split-hit", "rgb-shift"], "glitch transition": ["smear", "glitch", "shatter"],
  slice: ["preset-glitch", "glitch", "slice"], slices: ["preset-glitch", "glitch"], displace: ["preset-glitch", "displacement"], "torn bands": ["glitch"],
  smear: ["smear", "whip-pan", "update_project"], "quick smear": ["whip-pan", "directional-blur"], "one frame whip": ["whip-pan"], "frame smear": ["whip-pan", "directional-blur"],
  "short blur": ["directional-blur", "zoom-blur", "spin-blur"], "quick blur": ["directional-blur", "zoom-blur", "spin-blur"], "blur flash": ["directional-blur", "zoom-blur"], "one frame blur": ["directional-blur"], "blur pulse": ["directional-blur", "zoom-blur"], drag: ["smear"], "pixel drag": ["smear"], datamosh: ["smear"], mosh: ["smear"],
  // The project's shutter (update_project {shutterAngle}) smears every move in look and drafts.
  "motion blur": ["update_project", "motion-blur", "directional-blur", "spin-blur"], motionblur: ["update_project", "directional-blur"], shutter: ["update_project", "motion-blur"], "shutter angle": ["update_project", "motion-blur"],
  mosaic: ["mosaic-reveal", "mosaic"], "pixel grid": ["pixelate", "mosaic-reveal"], cells: ["mosaic-reveal"], blocks: ["mosaic-reveal"], tiles: ["mosaic-reveal"],
  "pixelate reveal": ["mosaic-reveal"], "pixel reveal": ["mosaic-reveal"], "mosaic reveal": ["mosaic-reveal"],
  shatter: ["shatter"], shattered: ["shatter"], glass: ["shatter", "fluted-glass"], "broken glass": ["shatter"], break: ["shatter"], shards: ["shatter"],
  "rgb split": ["rgb-split-hit", "rgb-shift"], "chromatic aberration": ["rgb-shift"],
  "color fringe": ["rgb-shift"], fringe: ["rgb-shift"], "edge fringe": ["rgb-shift"],
  twirl: ["twirl"], swirl: ["twirl"], vortex: ["twirl"], whirl: ["twirl"],
  "split screen": ["split-screen"], splitscreen: ["split-screen"], "side by side": ["split-screen"], panes: ["split-screen"], composite: ["split-screen", "picture-in-picture"],
  "picture in picture": ["picture-in-picture"], pip: ["picture-in-picture"], inset: ["picture-in-picture"],
  grain: ["grain", "scene-background"], vignette: ["vignette", "scene-background"], blur: ["zoom-blur", "directional-blur"], "freeze frame": ["freeze-shutter"],
  // Words for the effects that reports called missing (finish, depth, rim, streaks, highlight, typed
  // text); each leads to a name kino has (the test checks) or, with no maker, to NO_MAKER below.
  "film grain": ["grain", "scene-background"], "dark edges": ["vignette"], "darken edges": ["vignette"], edges: ["edge-lines", "rim-light", "cut_out", "vignette"], "dark corners": ["vignette"], "darker edges": ["vignette"], corners: ["vignette"], tunnel: ["vignette"],
  "depth of field": ["focus-band", "lift-focus"], dof: ["focus-band", "lift-focus"], "tilt shift": ["focus-band"], tiltshift: ["focus-band"], "shallow focus": ["focus-band", "lift-focus"],
  "focus blur": ["focus-band", "lift-focus"], "lens blur": ["focus-band"], "background blur": ["focus-band", "lift-focus"], "rack focus": ["focus-band", "lift-focus"],
  rim: ["rim-light", "glow", "cut_out"], "rim light": ["rim-light", "glow", "cut_out"], "rim lighting": ["rim-light", "glow", "cut_out"], "edge light": ["rim-light", "glow", "cut_out"], backlight: ["glow", "light-rays"],
  streak: ["streaks", "lens-flare", "speed-lines", "light-shape", "rain", "light-rays"], "light streak": ["lens-flare", "streaks", "light-shape", "light-rays"], anamorphic: ["lens-flare"], "lens streak": ["lens-flare"],
  "soft glow": ["glow"], dreamy: ["glow", "fog"],
  scrawl: ["text-ranges", "set_font", "outline_text"], brush: ["set_font", "outline_text"], handwritten: ["set_font", "outline_text"], handwriting: ["set_font", "outline_text"],
  "hand lettering": ["text-ranges", "set_font", "outline_text"], marker: ["set_font", "outline_text"], graffiti: ["set_font", "outline_text"], stencil: ["set_font"], blackletter: ["set_font"],
  typed: ["type-on", "voice-type"], typing: ["type-on", "voice-type"], typewriter: ["type-on", "set_font"], "type on": ["type-on"],
  highlight: ["type-on", "accent-hit", "luma-highlight", "caption-words"], highlighter: ["accent-hit", "luma-highlight"],
  // A look over the whole frame is one scene field (finish, letterbox); the effect does one layer.
  letterbox: ["scene-background"], letterboxed: ["scene-background"], "black bars": ["scene-background"], "cinema bars": ["scene-background"], "cinematic bars": ["scene-background"],
  "lifted blacks": ["scene-background", "color-look"], "film look": ["scene-background", "color-look"], "frame finish": ["scene-background"],
  soften: ["scene-background"], diffusion: ["scene-background"], "soft focus": ["scene-background"], hazy: ["scene-background", "fog"], mist: ["scene-background", "fog"],
  // Type, color and composite looks (the on-screen kinds a reference shows besides cuts and sound).
  font: ["set_font"], fonts: ["set_font"], typeface: ["set_font"], lettering: ["set_font"], typography: ["set_font"],
  // Matching a reference's lettering: library {topic:"fonts", like} (GAPS item 1).
  "match font": ["set_font"], "font match": ["set_font"], "same font": ["set_font"], "identify font": ["set_font"], "dot matrix": ["decode", "set_font"], "pixel font": ["set_font"], "rounded font": ["set_font"],
  // A bare "arc" is left out: it is also the ellipse sweep preset and a curved motion path.
  electric: ["lightning", "rim-light"], lightning: ["lightning"], "lightning bolt": ["lightning"], "electric arc": ["lightning"], "electric arcs": ["lightning"],
  bolt: ["lightning"], bolts: ["lightning"], thunder: ["lightning"], zap: ["lightning"], electricity: ["lightning"], spark: ["sparks", "lightning"],
  // Line art of footage (edge-lines) and a subject's edge as a drawn path (cut_out output "outline").
  edge: ["edge-lines", "rim-light", "cut_out"], "edge detect": ["edge-lines", "cut_out"], "find edges": ["edge-lines", "cut_out"],
  "line art": ["edge-lines", "cut_out"], contour: ["edge-lines", "cut_out"], contours: ["edge-lines", "cut_out"], sketch: ["edge-lines"], trace: ["trace_image", "cut_out", "edge-lines"],
  // A picture's flat colors as vector shapes (trace_image): a drawn prop, a logo, a brush word.
  vectorize: ["trace_image"], vector: ["trace_image"], "image trace": ["trace_image"], "trace image": ["trace_image"], wordmark: ["trace_image"],
  "logo shape": ["trace_image"], "drawn shape": ["trace_image"], "hand drawn": ["trace_image"], "brush lettering": ["trace_image", "set_font"], posterize: ["trace_image"],
  "subject outline": ["cut_out", "rim-light"], "outline path": ["cut_out"], "trace outline": ["cut_out", "rim-light"],
  outline: ["outline_text", "rim-light", "glow", "cut_out"], outlined: ["outline_text", "rim-light", "glow", "cut_out"], stroke: ["outline_text", "glow", "cut_out"],
  "typed highlight": ["type-on"], jitter: ["text-ranges"], "hand set": ["text-ranges"],
  hollow: ["layer-style"], "outline glow": ["layer-style", "glow"], "glow outline": ["layer-style", "glow"],
  "glowing outline": ["layer-style", "glow"], "neon text": ["layer-style", "glow"], "neon outline": ["layer-style", "glow"],
  "baseline shift": ["text-ranges"], "letter rotation": ["text-ranges"], "rotated letters": ["text-ranges"],
  "mirrored letter": ["text-ranges"], "flipped letter": ["text-ranges"], "backwards letter": ["text-ranges"], "mirror letter": ["text-ranges"], "flip letter": ["text-ranges"], "letter backwards": ["text-ranges"], "letters backwards": ["text-ranges"],
  "plain typing": ["type-on"], "fast typing": ["type-on"], "fast type": ["type-on"], "typed fast": ["type-on"], "type text": ["type-on"], "letters appear": ["type-on"],
  decode: ["decode"], decoding: ["decode"], "dots into letters": ["decode"], "dots and dashes": ["decode"], scramble: ["decode"], scrambled: ["decode"],
  duotone: ["duotone"], tritone: ["tritone"],
  // dot-grid is a circular halftone; keepPicture puts fine dots only in the shadows.
  halftone: ["dot-grid", "dithering"], "halftone dots": ["dot-grid", "dithering"], "screen tone": ["dot-grid"], screentone: ["dot-grid"], "comic dots": ["dot-grid"], "ben day": ["dot-grid"], dots: ["dot-grid"],
  "text behind": ["masked-type", "cut_out"], "behind text": ["masked-type", "cut_out"],
  "3d": ["card-flip", "3d-orbit"], "3d text": ["card-flip", "3d-orbit"], "3d type": ["card-flip", "3d-orbit"],
  streaks: ["streaks", "speed-lines", "rain", "light-rays"], 
  "code rain": ["streaks", "rain"], constellation: ["dust"], "connect the dots": ["dust"], "particle links": ["dust"], "light streaks": ["streaks", "lens-flare"], 
  "zoom burst": ["zoom-blur", "radial-repeat-blur"],
  "speed lines": ["speed-lines", "impact-lines"], "motion lines": ["speed-lines"], "action lines": ["impact-lines", "speed-lines"],
  "impact lines": ["impact-lines"], "focus lines": ["impact-lines"], "radial lines": ["impact-lines"], "anime lines": ["impact-lines", "speed-lines"], "manga lines": ["impact-lines", "speed-lines"],
  "punch in": ["punch-in"], punchin: ["punch-in"], "zoom punch": ["punch-in"], "snap zoom": ["punch-in"], "crash zoom": ["punch-in"],
  invert: ["invert"], inverted: ["invert"], negative: ["invert"], "inverted colors": ["invert"],
  "two color split": ["split-fields"], "color split": ["split-fields"], "split fields": ["split-fields"], "color fields": ["split-fields"], "two tone split": ["split-fields"],
  // A wipe whose edge travels across the picture is split-fields (straight or brush edge); shape-wipe grows a shape from one point.
  "brush edge wipe": ["split-fields", "shape-wipe", "shape-modifiers"], "brush wipe": ["shape-wipe", "split-fields", "shape-modifiers"],
  "edge wipe": ["split-fields", "shape-wipe"], "straight edge": ["split-fields", "shape-wipe"], "moving edge": ["split-fields", "shape-wipe"], "straight wipe": ["split-fields", "shape-wipe"], "sweeping edge": ["split-fields", "shape-wipe"], "line wipe": ["split-fields", "shape-wipe"],
  wipe: ["shape-wipe", "split-fields", "slice"],
  "brush edge": ["shape-modifiers", "split-fields", "shape-wipe"], "rough edge": ["shape-modifiers", "split-fields", "shape-wipe"], "ragged edge": ["shape-modifiers", "shape-wipe"],
  "torn edge": ["shape-modifiers", "shape-wipe"], "jagged edge": ["shape-modifiers", "shape-wipe"], "dry brush": ["shape-modifiers", "split-fields"], "brush mask": ["shape-modifiers", "shape-wipe"],
  // The project's frame rate (update_project {fps}, project create {fps}).
  "frame rate": ["update_project"], framerate: ["update_project"], fps: ["update_project"], "frames per second": ["update_project"], "23.976": ["update_project"], "on frame": ["update_project"],
  // roughenStyle torn and brush (GAPS item 12: "torn paper edge texture" found edge-lines).
  torn: ["shape-modifiers"], ragged: ["shape-modifiers"], ripped: ["shape-modifiers"], tear: ["shape-modifiers"], "torn paper": ["shape-modifiers"], "ripped paper": ["shape-modifiers"],
  "paper edge": ["shape-modifiers"], "paper tear": ["shape-modifiers"], "brush stroke": ["shape-modifiers", "shape-wipe"], "brush streaks": ["shape-modifiers"],
  // A splatter path (GAPS item 11: "paint splatter splash shapes" found no name).
  splatter: ["splatter"], splat: ["splatter"], splats: ["splatter"], splash: ["splatter"], splashes: ["splatter"], "ink splash": ["splatter"], "paint splash": ["splatter"],
  "paint splatter": ["splatter"], "ink splatter": ["splatter"], blot: ["splatter"], "ink blot": ["splatter"], drips: ["splatter"], "paint drips": ["splatter"], "spray paint": ["splatter"],
  "torn paper edge": ["shape-modifiers"], roughen: ["shape-modifiers"], roughened: ["shape-modifiers"],
  "film burn": ["film-burn"], burn: ["film-burn"], "light burn": ["film-burn"], "film damage": ["film-burn", "grain"], "old film": ["film-burn", "grain", "vignette"],
  // Findability round (recreate test, GAPS "Findability"): kino had each of these and the director's words missed it.
  // Halftone and dots: dot-grid draws the picture as dots (dithering is the retro dot-pattern posterize).
  "dot screen": ["dot-grid"], "dot pattern": ["dot-grid", "dithering"], newsprint: ["dot-grid"], "print dots": ["dot-grid"], stipple: ["dot-grid", "dithering"], 
  // Dashed and dotted lines are the dash list of a stroke (layer-style).
  dashed: ["layer-style"], dotted: ["layer-style"], dashes: ["layer-style"], dash: ["layer-style"], "dashed line": ["layer-style"], "dotted line": ["layer-style"], "dashed stroke": ["layer-style"], "dotted stroke": ["layer-style"], "dashed outline": ["layer-style"], "dotted outline": ["layer-style"],
  // Pixel mosaic: the pixelate effect (preset-pixel is an In/Out reveal, not a look to hold).
  pixelate: ["pixelate"], pixelated: ["pixelate"], pixelation: ["pixelate"], pixel: ["pixelate"], "pixel mosaic": ["pixelate"], "pixel blocks": ["pixelate"], "big pixels": ["pixelate"], "square pixels": ["pixelate"], blocky: ["pixelate"], "low res": ["pixelate"], "low resolution": ["pixelate"],
  // Whole-frame cinema bars: scene letterbox.
  widescreen: ["scene-background"], "wide screen": ["scene-background"], cinemascope: ["scene-background"], "scope bars": ["scene-background"], bars: ["scene-background"],
  // On twos and on threes: the frameRate of a layer; choppy is also the clip's mediaFrameRate.
  "on twos": ["layer-frame-rate"], "on threes": ["layer-frame-rate"], twos: ["layer-frame-rate"], threes: ["layer-frame-rate"], choppy: ["layer-frame-rate", "clip-speed"], stepped: ["layer-frame-rate"], "stop motion": ["layer-frame-rate", "clip-speed"],
  stopmotion: ["layer-frame-rate", "clip-speed"], "posterized time": ["layer-frame-rate"], "held frames": ["layer-frame-rate"], "hold frames": ["layer-frame-rate"], "low frame rate": ["layer-frame-rate", "clip-speed"],
  // Motion blur from movement (render shutterAngle), and the effects that smear on purpose.
  "rotation motion blur": ["motion-blur", "spin-blur"], "rotation blur": ["spin-blur", "motion-blur"], "rotational blur": ["spin-blur", "motion-blur"],
  shutterangle: ["motion-blur"], "motion smear": ["motion-blur", "directional-blur"], "blur on move": ["motion-blur"], "blur from movement": ["motion-blur"],
  // Fill the edges where the picture stops short: edge-fill.
  "fill the edges": ["edge-fill"], "fill edges": ["edge-fill"], "stretch edges": ["edge-fill"], "extend edges": ["edge-fill"], "extend the edges": ["edge-fill"], "edge pixels": ["edge-fill"], "black strip": ["edge-fill"], "black sliver": ["edge-fill"], "gap at the edge": ["edge-fill"], "extend the frame": ["edge-fill"],
  // Tilt and perspective: rotateX, rotateY and perspective on any layer (the tilt topic); the moves tilt a card or lay a screen on a plane.
  tilt: ["tilt", "card-tilt", "ui-plane"], tilted: ["tilt", "ui-plane"], tilting: ["tilt", "card-tilt"], perspective: ["tilt", "ui-plane", "card-tilt"], "3d tilt": ["tilt", "ui-plane"], "3d plane": ["tilt", "ui-plane"], rotatex: ["tilt"], rotatey: ["tilt"], "rotate x": ["tilt"],
  foreshorten: ["tilt"], foreshortened: ["tilt"], keystone: ["tilt"], "lean back": ["tilt"],
  // Type or a plate mixed into the picture (not an opacity fade): the blendMode of a layer.
  "blend mode": ["blend-mode"], "blend modes": ["blend-mode"], blend: ["blend-mode"], blending: ["blend-mode"], multiply: ["blend-mode"], "text blend": ["blend-mode"], "text fading": ["blend-mode"], "through the picture": ["blend-mode"], "through picture": ["blend-mode"],
  "darken blend": ["blend-mode"], "multiply blend": ["blend-mode"], "screen blend": ["blend-mode"], "add blend": ["blend-mode"], "mix with the picture": ["blend-mode"], "blend with the picture": ["blend-mode"],
  // Words for seeing many frames at once (the look tool, not an effect); look-times is its topic.
  "contact sheet": ["look-times"], "many frames": ["look-times"], "chosen times": ["look-times"], "every nth frame": ["look-times"], "frame strip": ["look-times"], "side by side frames": ["look-times"],
  "several times": ["look-times"], "several frames": ["look-times"], "frames at once": ["look-times"], "before during after": ["look-times"],
  // A clip's own sound kept in the edit: keep_line, or planned on a board shot as sound {keep} (engine/boardSound.js).
  "clip sound": ["keep_line"], "own sound": ["keep_line"], "original sound": ["keep_line"], "original audio": ["keep_line"], "keep sound": ["keep_line"], "scene audio": ["keep_line"], "clip audio": ["keep_line"],
  // A sound in the clip that is not a line (keep_line {sound}, the clip readout's `sounds`).
  "scene sound": ["keep_line"], "scene sounds": ["keep_line"], "clip sounds": ["keep_line"], "keep the laugh": ["keep_line"], "keep laugh": ["keep_line"], "laugh in the clip": ["keep_line"], "sound in the clip": ["keep_line"], "non speech sound": ["keep_line"],
  // The board's pace beside the references and its cuts moved onto the song's beats (board {snap:"beats"}; topic beats).
  "snap to beat": ["beats"], "snap cuts": ["beats"], "cuts on the beat": ["beats"], "cut pace": ["beats"], "pace after the drop": ["beats"], "shots per second": ["beats"],
};
// Looks kino has no maker for yet. Asked for alone, they print a line that says so (and what to do)
// instead of a name that only sounds close.
// (halftone left this list: dot-grid draws it, see SEEN_AS.)
const NO_MAKER = ["dirt texture", "paper texture"];
// Looks with no maker of their own that still have a way to build them from kino's parts.
const NO_MAKER_HOW = {};
export { SEEN_AS };
// Common words that mean a look only on their own: "green" alone is a tint, but "green screen" is
// a cut-out and "repeat text" is not a footage stutter. Inside a longer query they lead nowhere.
// "edges" and "corners" alone are a vignette, but "rounded corners" or "jagged edges" are not.
// Words every kino answer uses: they never pick a name just by being a part of it (layer-style).
const GENERIC = new Set(["layer", "text", "style", "ranges", "scene"]);
const LOOSE = new Set(["green", "repeat", "ramp", "reverse", "hit", "grade", "tint", "flash", "fire", "ash", "rays", "beams", "echo", "blur", "flare", "matte", "grain", "burn", "negative", "inverted", "edges", "corners", "tunnel",
  // "dots" in "connect the dots", "pixel" in "pixel drag", "bars" in "progress bars", "tilt" in "tilt shift", "slice" in "slice the clip"
  // ("dash" leads anywhere: "dash outline" is a dashed stroke too):
  "dots", "pixel", "bars", "tilt", "slice", "slices", "stepped", "blend"]);

// The last line of look {mode:"reference"}: what the agent sees there, as a lookup.
export const REFERENCE_LOOKUP = 'to make what you see (kinds: type, overlay, composite, color, made, frame, spoken, plain): library {topic:"search", search:"<your words: font, glow, cut-out, split screen, duotone, outline>"}';

/**
 * A second lookup line for a studied reference whose title has the subject's origin word
 * (`found` is next-call.mjs originFootage's answer), else "": the footage search that finds it.
 */
export function originReferenceLine(found, title) {
  const has = found && (String(title ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).includes(found.word);
  return has ? `to find the footage it shows: library {topic:"footage", search:${JSON.stringify(found.query)}}` : "";
}

// Guide topics that hold each effect group's rules.
const GROUP_TOPIC = { Light: "light", Generate: "particles", Color: "color", Blur: "blur" };
/** The guide topic that holds the rules of an effect group (effects for the groups without their own). */
export const ruleTopicOf = (group) => GROUP_TOPIC[group] ?? "effects";
// Guide topics an agent reads instead of an op, effect or move (clip speed is layer properties).
const TOPICS = { "clip-speed": "layer properties mediaSpeed and speed animations",
  "text-ranges": "textStyleRanges (rotation, baselineShift, scaleX -1 mirrors, fill) and the layer field jitter",
  "shape-modifiers": 'layer properties roughenSize and roughenStyle "torn" (torn paper) or "brush" (dry-brush streaks along roughenAngle) on a shape or path',
  splatter: 'add_layer {layerType:"path", properties:{splatter:{style:"splat"|"splash"|"drip"|"spray", seed}, width, height, fill}}',
  "layer-style": 'layer properties fill (a color, or a gradient {type, angle, stops} for a light plate or wash), strokes (dash:[10,8] dashed, dash:[1,12] with cap:"round" dotted), shadows and outlineGlow (hollow letters with a glowing outline)',
  // Layer fields that live in a guide topic of their own: the name is a plain handle, TOPIC_ID the topic that reads it.
  "layer-frame-rate": 'layer property frameRate (1 to 120; null removes it) steps a layer\'s motion: "on twos" is 12 at 24 fps, "on threes" 8; mediaFrameRate steps a clip\'s picture',
  "motion-blur": "update_project {properties:{shutterAngle:180}} (look and drafts) and render options {shutterAngle: 0 to 360, motionSamples: 2 to 16} blur whatever moves (position, scale, rotation, a whip); spin-blur and directional-blur are the effects for a smear you choose",
  tilt: "layer properties rotateX, rotateY (degrees) and perspective: a plate or screen lying in 3D, set with update_layer or animated",
  "blend-mode": "layer property blendMode: multiply and darken keep the darker of layer and picture (dark type sinks in, white drops out), screen and add keep the lighter, overlay and soft-light mix contrast",
  "preset-glitch": 'add_animation {layer, preset:"preset-glitch", parameters:{sliceSize:30}}: slices of the layer shift sideways with a color split',
  "scene-background": 'the whole frame in one op: {op:"update_scene", properties:{finish:true, letterbox:2.35}} (grain, lifted blacks, halation, vignette, bars)',
  "look-times": 'the look tool, not an edit: look {mode:"frames", times:[0.5, 1, 1.2], layer?} draws up to 60 chosen times as labeled pages; every:4 thins a range' };
const TOPIC_ID = { "layer-frame-rate": "clip-speed", "motion-blur": "blur", "blend-mode": "color", "preset-glitch": "effect-presets" };
// One line of when each look fits, shown after its name (a name with none shows nothing more).
// Written from each effect's catalog hint and the particles rules; a guide for the pick, not a rule.
const WHEN = {
  embers: "rising warm specks: fire, heat, a warm night scene", sparks: "bright bits thrown outward: an impact, a hit, a burst", bokeh: "soft out-of-focus lights: night city, dreamy, a plate behind type",
  dust: "slow drifting specks (links joins them into a network): air in a light beam, calm, tech", snow: "falling flakes: winter, soft quiet", rain: "falling streaks: rain, storm, code rain",
  fog: "drifting haze: mood, depth behind a subject", streaks: "long moving lines: speed, code rain, motion", "light-leaks": "warm color washes: filmic, nostalgic",
  "dot-grid": "a halftone: the whole picture drawn as dots", pixelate: "a pixel mosaic: big square cells over a picture", "edge-fill": "stretches the edge pixels out where a moved picture leaves a gap",
  // A director wanted a brush edge sweeping across in 4 frames (contest-a f849-852) and got shape-wipe's growing shape;
  // split-fields drifts its edge 0.15 of the frame by default, so the line names the field that makes it sweep.
  "split-fields": "an edge moving across one shot, a color field each side: travel:-1 sweeps it left to right over the whole frame (a wipe), 1 right to left",
  "shape-wipe": "a shape growing from one point to the next shot (point, shape circle, rounded, diamond, clock)",
  keep_line: 'a clip\'s own sound heard over the music (sound:"laughter" keeps a sound the readout lists); on the board: shot sound {keep:"all" | [from, to] | "laughter"} (file seconds)',
  place_sounds: 'a sound on a visible action, its transient on the frame, 3 LU under the song: library {topic:"sounds", actions:true} lists the actions',
};
// An op whose call needs a lookup first: a font is picked by its look.
const OP_USE = { update_project: 'update_project {properties:{shutterAngle:180}} (motion blur on every move in look, sheets and drafts)', set_font:'library {topic:"fonts", search:"<the look: brush, handwritten, marker, stencil, slab, blackletter, condensed bold sans, a script such as japanese>"} (or like:"<picture path>", region:[x,y,w,h]: faces measured like its letters) then set_font {layerIds, family, weight}' };

/** The line for a look kino has no maker for yet ("speed lines"), else "". */
export function noMakerLine(query) {
  const text = ` ${String(query ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const phrase = NO_MAKER.find((entry) => text.includes(` ${entry} `));
  return phrase ? `no kino name for "${phrase}" yet: ${NO_MAKER_HOW[phrase] ? `build it from ${NO_MAKER_HOW[phrase]}` : "build it from shapes and draw-on"}, or say it is missing` : "";
}

/** The call that reads a name's rules, and what the name is; null for a name kino does not have. */
export function readCallFor(name, { ops = [] } = {}) {
  const effect = EFFECTS.find((entry) => entry.key === name);
  if (effect) return { kind: "effect", use: `add_animation {layer, effect:"${name}"}`, read: `fields: library {topic:"effects", name:"${name}"}; rules: library {topic:"rules", name:"${ruleTopicOf(effect.group)}"}` };
  if (MOVE_NAMES.includes(name)) return { kind: "move", use: `move {name:"${name}", …}`, read: `library {topic:"moves", name:"${name}"}` };
  if (ops.includes(name)) return { kind: "op", use: OP_USE[name] ?? `${name} {…}`, read: `library {topic:"op", name:"${name}"}` };
  if (TOPICS[name]) return { kind: "topic", use: TOPICS[name], read: `library {topic:"rules", name:"${TOPIC_ID[name] ?? name}"}` };
  return null;
}

/**
 * The kino names that make what `query` describes, best first: a name equal to the query, then
 * the names its words stand for (SEEN_AS), then names that hold one of its words. One line each.
 */
export function seenNames(query, { ops = [], limit = 5 } = {}) {
  return seenNameList(query, { ops }).slice(0, limit).map((name) => {
    const call = readCallFor(name, { ops });
    return `${name} (${call.kind}: ${call.use}; ${call.read})${WHEN[name] ? `: ${WHEN[name]}` : ""}`;
  });
}

/** The bare kino names of seenNames, best first, all of them (the deck reads labels with it; "cut_out" is always an op here). */
export function seenNameList(query, { ops = ["cut_out", "keep_line", "trace_image"] } = {}) {
  // Punctuation and case do not count ("Bloom!" is bloom; "cut_out" and "cut-out" are cut out).
  const text = String(query ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!text) return [];
  const words = text.split(" ").filter((word) => word.length > 2);
  const joined = text.replace(/ /g, "-");
  const all = [...EFFECTS.map((entry) => entry.key), ...MOVE_NAMES, ...ops, ...Object.keys(TOPICS)];
  const found = [];
  const add = (name) => { if (!found.includes(name) && readCallFor(name, { ops })) found.push(name); };
  for (const name of all) if (name === joined || name === text.replace(/ /g, "_")) add(name);
  for (const name of SEEN_AS[text] ?? []) add(name);
  for (const key of Object.keys(SEEN_AS)) if (key.includes(" ") && ` ${text} `.includes(` ${key} `)) for (const name of SEEN_AS[key]) add(name);
  for (const word of words.filter((entry) => !LOOSE.has(entry))) for (const name of SEEN_AS[word] ?? []) add(name);
  // Else a word that is a whole part of a name ("leaks" in light-leaks).
  // Ops are left out here: the search's ops line already lists the ops that hold a word.
  if (!found.length && !noMakerLine(text)) for (const word of words.filter((entry) => entry.length > 3 && !LOOSE.has(entry) && !GENERIC.has(entry))) for (const name of all.filter((entry) => !ops.includes(entry))) if (name.split("-").includes(word)) add(name);
  return found;
}
