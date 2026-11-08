// The technique vocabulary: named editing and motion techniques that the checks, the style spec
// (brief field `style`), moves, the deck and the "another AI" test all use. A tag is the shared
// word for one technique, so keep the names exactly as they are.
//
// Each technique has:
//   tag      the name, lowercase with dashes
//   group    transition, camera, type, texture, set-piece or rhythm
//   line     what it is, in one plain line
//   fits     when it fits a video
//   detect   true when kino can find it in a document (engine/quality/techniques.js); false when it
//            cannot yet, and `why` says what is missing.

const technique = (tag, group, line, fits, detect = true, why = undefined) => Object.freeze({ tag, group, line, fits, detect, ...(why ? { why } : {}) });

// Set pieces kino has no move for yet (moves record their tags in scene.moves, which check reads).
const MOVES = "no move builds it yet; the document has no mark for it";

export const TECHNIQUES = Object.freeze([
  // Transitions: how one shot or section turns into the next.
  technique("cut", "transition", "the picture changes from one frame to the next", "action, speech and music that drive the change"),
  technique("match-cut", "transition", "a cut that joins two shots by a shared shape, place or motion", "two shots with a common shape or movement", false, "needs the shapes in the picture (a vision model)"),
  technique("dissolve", "transition", "two full-frame pictures cross, one fading in over the other", "screen recordings, time passing, a calm or dreamy tone"),
  technique("fade-black", "transition", "the picture fades to dark, then the next fades up", "the end of a chapter, a pause before the reveal"),
  technique("blur-through", "transition", "the picture blurs out and the next blurs in", "soft changes inside one place or one idea"),
  technique("zoom-through", "transition", "a fast large zoom into the picture carries into the next shot", "energy, going inside a screen or an object"),
  technique("whip-pan", "transition", "a fast slide of the whole picture with motion blur into the next shot", "fast pace, moving between places"),
  technique("mask-wipe", "transition", "the next picture is revealed through a moving edge or shape", "graphic, designed edits; a shape that leads the eye"),
  technique("glitch-hit", "transition", "a short digital glitch on a change or an entrance", "tech, noise, a hard accent"),
  technique("flash", "transition", "a short bright frame on the change", "a hit in the music, a photo flash, impact"),
  technique("push-transition", "transition", "the old picture is pushed off as the new one slides in", "slides, lists, phone screens, things in a row"),
  // Camera: how the frame itself moves.
  technique("slow-push", "camera", "a slow zoom in (or out) on a large picture over seconds", "holding on a picture or a line without it feeling still"),
  technique("drift", "camera", "a slow sideways or vertical move of a large picture", "calm stretches, a still image that should feel alive"),
  technique("parallax", "camera", "layers at different depths move at different speeds", "depth from flat material: cutouts, type over footage"),
  technique("orbit-3d", "camera", "the picture turns in 3D space", "showing a device or a card from another side"),
  technique("speed-ramp", "camera", "footage speeds up or slows down within a shot", "action, skating, a moment to stretch"),
  technique("freeze-frame", "camera", "footage stops on one frame", "a moment to point at, a name or a punchline"),
  technique("shake", "camera", "the picture shakes or wiggles", "impact, bass hits, handheld energy"),
  // Type: how words come on screen.
  technique("type-cut", "type", "text appears at once, with no entrance", "speech-led and plain edits; text that follows the cut"),
  technique("type-fade", "type", "text fades in", "quiet, elegant moments"),
  technique("type-slide", "type", "text slides in from a side", "lists, steps, labels"),
  technique("type-pop", "type", "text grows or pops in, often with a small overshoot", "playful, punchy beats"),
  technique("type-words", "type", "text is revealed word by word", "captions read in time with the voice, lowercase captions"),
  technique("type-letters", "type", "text is revealed letter by letter", "titles, typing, a name"),
  technique("type-mask-rise", "type", "text rises into view from behind an edge", "editorial titles, clean reveals"),
  technique("type-blur-in", "type", "text comes into focus from a blur", "soft, dreamy or tech titles"),
  technique("type-giant", "type", "oversized type that fills most of the frame", "one word that is the whole message; pushing through type"),
  technique("type-counter", "type", "a number counts up or down", "stats, prices, time"),
  technique("type-swap", "type", "one text changes into another in place", "a word that changes its meaning, lists in one place"),
  technique("accent-hit", "type", "one word or shape flashes to an accent color with a glow and settles back", "the word that matters, a verb as it is said, a status turning on"),
  technique("type-kinetic", "type", "text keeps moving after it arrives (turns, scales, travels)", "music-led edits, lyrics, energy"),
  // Texture: what is laid over or into the picture.
  technique("speed-lines", "texture", "streaks that show fast movement", "speed, a phone flying in"),
  technique("particles", "texture", "particles: dust, snow, sparks, embers, rain, bokeh, fog", "atmosphere, weather, celebration"),
  technique("rgb-split", "texture", "the color channels pull apart", "tech, noise, a glitchy accent"),
  technique("light-sweep", "texture", "light passes over the picture (rays, flare, leaks)", "a reveal, warmth, a product shine"),
  technique("grain", "texture", "film grain or noise over the picture", "film look, analog warmth"),
  technique("vignette", "texture", "the picture darkens toward its edges and corners", "film look, pulling the eye to the middle"),
  technique("depth-blur", "texture", "a blurred full-frame picture behind sharp layers", "floating clips or text in front of a scene"),
  technique("motion-blur", "texture", "a directional, zoom or spin blur on something that moves", "fast moves that should feel physical"),
  // Set pieces: bigger designed moments, built by moves.
  technique("tile-ring", "set-piece", "one clip breaks into a turning ring of tiles", "a hero moment for one clip"),
  technique("clip-field", "set-piece", "a 3D field of floating clips with depth blur", "many clips at once: a product's range, a community", false, MOVES),
  technique("draw-on", "set-piece", "a line, outline or route draws itself on along its stroke", "underlines, circled numbers, map routes, diagrams, signatures"),
  technique("swipe-cards", "set-piece", "cards swipe past like a phone UI", "apps, choices, lists"),
  technique("logo-match-move", "set-piece", "the logo flies into a place in a screenshot or scene", "ending on the product in use"),
  technique("status-line", "set-piece", "a persistent icon with a live status line ('is speaking...')", "assistants, live apps"),
  technique("split-screen", "set-piece", "two or more clips side by side", "comparisons, before and after, two places at once"),
  technique("device-in-scene", "set-piece", "a device mockup placed in the scene with the footage", "apps shown in real life", false, MOVES),
  technique("ui-build", "set-piece", "the parts of a real screenshot come in one by one, each resolving from a blur", "an app panel, list or table built up row by row"),
  technique("screen-zoom", "set-piece", "a zoom into a screen recording to one detail", "UI details, a button, a number"),
  technique("cursor", "set-piece", "a pointer glides to a real button in the product and clicks it, or drags a card", "showing what a person does in the app"),
  // Rhythm: how the edit relates to the music.
  technique("beat-cut", "rhythm", "a cut on the beat", "music-led edits"),
  technique("beat-kick", "rhythm", "a small scale pulse on the beat", "a bass hit worth feeling, used now and then"),
  technique("syncopated", "rhythm", "cuts or accents placed between beats on purpose", "variety in music-led edits"),
  technique("roll", "rhythm", "a run of words, pictures or clips in one place that speeds up and lands on one", "a list that builds to the product's name; a montage into the payoff"),
  technique("hold", "rhythm", "a long still moment with nothing changing", "letting something land; contrast after a fast run"),
]);

export const TECHNIQUE_GROUPS = Object.freeze(["transition", "camera", "type", "texture", "set-piece", "rhythm"]);
export const TECHNIQUE_TAGS = Object.freeze(TECHNIQUES.map((entry) => entry.tag));
const BY_TAG = new Map(TECHNIQUES.map((entry) => [entry.tag, entry]));

/** The technique with this tag, or undefined. */
export const techniqueOf = (tag) => BY_TAG.get(tag);
export const isTechnique = (tag) => BY_TAG.has(tag);
/** The tags kino can find in a document. */
export const DETECTABLE_TAGS = Object.freeze(TECHNIQUES.filter((entry) => entry.detect).map((entry) => entry.tag));
// Techniques that are the plain default of any edit, not a designed choice: few_techniques does
// not count them and technique_repeat does not limit them.
export const PLAIN_TAGS = Object.freeze(["cut", "type-cut", "hold"]);
// Where a cut falls against the beat: a property of the cuts, so few_techniques does not count
// them as techniques of their own either.
export const CUT_TIMING_TAGS = Object.freeze(["beat-cut", "syncopated"]);

/**
 * library {topic:"techniques"}: every tag by group in a few short lines, or one technique in full
 * when `name` is a tag.
 */
export function techniquesText(name = "") {
  if (name) {
    const entry = techniqueOf(String(name));
    if (!entry) return null;
    return `${entry.tag} (${entry.group}): ${entry.line}. Fits: ${entry.fits}.${entry.detect ? "" : ` check cannot find it yet: ${entry.why}.`}`;
  }
  return [
    ...TECHNIQUE_GROUPS.map((group) => `${group}: ${TECHNIQUES.filter((entry) => entry.group === group).map((entry) => entry.tag + (entry.detect ? "" : "*")).join(", ")}`),
    "* check cannot find it in a document yet.",
    'library {topic:"techniques", name:"<tag>"} for one. Style spec: notes {action:"brief", fields:{style:{wants:[tags], avoids:[tags], lines:[{text, ref, at, tags}], by, quote?}}}.',
  ].join("\n");
}
