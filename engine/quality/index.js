// The quality checker: every rule, and the function that runs them on a model
// (engine/quality/model.js). Gates are errors that block a final render; warnings are shown only.
// Data rules read the model; pixel rules also render frames (ctx.renderFrames).
import { contrast, flashing } from "./pixels.js";
import { frozenPicture, lumaJump } from "./motionPixels.js";
import { accentStripe, cardGrid, centeredRun, glowBlobPill, overlap, safeZone } from "./rules/layout.js";
import { defaultFont, gradientBanding, gradientText, neonOnDark, pureFrame } from "./rules/look.js";
import { bouncyLayers, durationBand, easingRepeat, exitRatio, firstEntrance, judder, linearMotion, sameMotion, speedJump, springOnFade, staggerLong, staggerOrder } from "./rules/motion.js";
import { assertions, noRhythm, offBeat, promoBasics, sceneLengths, staticScene, transitionsDense } from "./rules/pacing.js";
import { referenceCloseness, referenceDrift } from "./rules/reference.js";
import { endingSeen, seenBefore } from "./rules/seenBefore.js";
import { hold, readingTime, typeMin } from "./rules/text.js";
import { blurredBackdrop, ownWords, sameEntrance, softCuts, stackedLabel, stockCopy, textGlow, wordByWord } from "./rules/tells.js";
import { driftOnEveryShot, evenShotLengths, fadeOnlyEntrances, pageChrome, splitCardLayout } from "./rules/aiTells.js";
import { cutOffAtRest, fontFallback, heldStatic, offBrandFont, renderArtifact, smallOnEmpty, textCollision, textGhost, textOnBusy, textWrap } from "./rules/polish.js";
import { frozenScreen, screenUnreadable } from "./rules/screens.js";
import { speechCaptions, speechCut, speechQuotes } from "./rules/speech.js";
import { bedJump, endOnFade, muteWord, musicHardStop, musicStall, musicTurn, noMusic, sfxRestraint, speechFragment, voiceLevelSpread, voiceUnderBed, volumeChurn } from "./rules/sound.js";
import { textLoad } from "./rules/load.js";
import { cutMidMove, edgeLinger, loneZoom, transitionDip } from "./rules/camera.js";
import { clipReuse, cropNoSubject, frozenFootage, jumpCut, softUpscale, trackLost } from "./rules/footage.js";
import { darkUnderTitle, lowFpsMotion, sourceJump } from "./rules/sourcePixels.js";
import { headCutOff } from "./rules/people.js";
import { outOfSync } from "./rules/sync.js";
import { beatKick, cutMotivation, deckUnused, fewTechniques, flatSections, metronome, plainBeats, styleAvoided, styleWanted, techniqueRepeat, textSlides } from "./rules/style.js";
import { TASTE_WARNINGS, accentBudget, brandConsistency, endingCount, hookReadable, templateEnd, textOnlyOpen, overlayCoversSubject, pacingJump, roleFontDrift, storyStall, vocabularyBudget } from "./rules/consistency.js";
import { rejectedText, spineDrift } from "./rules/spine.js";
import { signatureMissing } from "./rules/signature.js";
import { busyEdit, restraint } from "./rules/restraint.js";
import { requestUnmet } from "./rules/request.js";
import { styleContext } from "../styleSpec.js";
import { sec } from "./analysis.js";
import { chainOf } from "./model.js";

// askOnly: a costly rule that runs only when check names it (check {rules:["source_jump"]}).
// final: a warning while editing that blocks a final render (FINAL_GATES).
const rule = (code, level, check, summary, pixels = false, { askOnly = false, final = false } = {}) => ({ code, level, check, summary, pixels, askOnly, final });

export const RULES = [
  rule("linear_motion", "error", linearMotion, "no linear easing on position, scale or rotation (except perpetual layers and a slow push: a custom animation of 2 s or more, position and scale only, of a non-text layer filling half the frame or a background, its part on screen moving under 4% of the frame diagonal a second)"),
  rule("reading_time", "error", readingTime, "each text readable for max(characters ÷ 20, 20 frames)"),
  rule("type_min", "error", typeMin, "body ≥36 px and headline ≥64 px at 1080p (9:16: 32 and 90); the fix grows the size and its box"),
  rule("overlap", "error", overlap, "no unintended overlap, covering or clipping of text or logos"),
  rule("safe_zone", "error", safeZone, "text, logo and CTA inside the safe zone while still"),
  rule("contrast", "error", contrast, "4.5:1 (3:1 large text) on the real pixels behind the text, in its colour at that time (fill animations included; a fill faded to transparent counts as hidden, like an opacity fade); says how long each failure lasts, and one under 0.2 s (a flash behind the text, or what is behind it settling as the text starts or ends) is a warning", true),
  rule("flashing", "error", flashing, "at most 3 flashes a second over 2.8% of the frame (a flash: two opposite luminance changes of 10% or more, WCAG 2.3.1); a deliberate flash under the limit passes", true),
  rule("luma_jump", "error", lumaJump, "off a cut, brightness moves at most 12 levels (0-255) in 0.2 s when a large layer pops on or off or in a zoom or push, and stays within 8 levels of both shots inside a transition (fade_black, flash, short light shapes and cuts are planned); waive a planned beat", true),
  rule("frozen_picture", "error", frozenPicture, "the rendered picture inside a video layer's box (any size: a phone screen counts) changes within every 0.3 s while it is on screen; a still placed on a sound hit or a spoken line only warns, not at the shot's cut-in; waive_check a deliberate freeze frame", true),
  rule("assertions", "error", assertions, "the scene's own promises hold"),
  rule("spring_on_fade", "error", springOnFade, "no bounce or overshoot on opacity or colour"),
  rule("same_motion", "error", sameMotion, "4+ animated layers do not all share one easing and duration"),
  rule("promo_basics", "error", promoBasics, "promo/ad: logo and message by 5 s, a ≥30% hero, a CTA in the last 20%"),
  rule("font_fallback", "error", fontFallback, "each text draws in the family and weight it asks for (not a fallback face or the nearest loaded weight)"),
  rule("text_collision", "error", textCollision, "readable texts, and a text and another text's plate (pill, tile), do not touch on screen"),
  rule("text_ghost", "error", textGhost, "two different texts are not both seen (over 25% opacity, one mid-fade) in one place (over 30% of the smaller box) for more than 2 frames; slide or mask swaps, a zoom through (1.4x), a blur dissolve, a shadow copy and allowOverlap pass; auto: the incoming entrance starts once the old text is gone"),
  rule("speech_cut", "error", speechCut, "a heard voice clip does not start or stop inside a word or a sentence the file goes on saying (next word within 0.6 s, previous within 0.3 s); a faded word is a warning; needs a transcript (whisper). Loud cuts count too: 12 dB over the file's quiet level in the 120 ms inside a cut near a word is the same gate, and a clip played to a file's loud end"),
  rule("soft_upscale", "error", softUpscale, "an image or video is never drawn at more than 2 output pixels per file pixel (over 1.3 is a warning; its scale and zoom animations and its parents' included; a blur of 16 or more is left alone); needs the file's size (imported media)"),
  rule("frozen_footage", "error", frozenFootage, "a clip on screen (30% of the frame or more) never shows a frozen picture for 0.3 s or more: slowed to a stop, held before or after its play range, or a still put in its place where it ends or starts; a freeze placed on a sound hit or a spoken line only warns, not at the shot's cut-in; waive_check a deliberate freeze frame"),
  rule("lone_zoom", "error", loneZoom, "a clip or picture (8% to 90% of the frame) that grows or shrinks 12% in 0.5 s (or crosses a frame width a second) is not the only thing moving: the shot seen behind it moves too (a flat layer 85% opaque hides what is under it; over flat color with no shot under it, and an entrance or exit, are left alone)"),
  rule("edge_linger", "error", edgeLinger, "a moving painted layer seen half in frame at some time is never a sliver at the frame edge (under 25% of it and 15% of the frame seen, opaque layers over it counted) for 0.3 s while slower than 0.25 frame widths a second"),
  rule("style_avoided", "error", styleAvoided, "no technique the style spec avoids (an error only when the avoids are the person's words, by:\"you\" with a quote; a guessed avoid warns); waive_check a deliberate use"),
  rule("spine_drift", "error", spineDrift, "with a story spine (style.spine): no stretch over 2 s in no beat, the problem beat by 15% of the runtime (3 s at least), one payoff with only the end after it (a second payoff warns), beats (none past the end) and their used layers in the spine's order"),
  rule("rejected_text", "error", rejectedText, "no on-screen text (one layer, or two shown together) nearly saying what the person turned down (style.rejected; case, punctuation and spelled numbers ignored)"),
  rule("overlay_covers_subject", "error", overlayCoversSubject, "a layer over footage covers at most 30% of the marked subject for 0.5 s (full-clip frames and scrims aside); a gate for an opaque layer or caption over its middle (auto: moved aside), a warning for light tints and big type; unmarked, a warning over a found face or raised hands"),
  rule("out_of_sync", "error", outOfSync, "a line heard from one file over the picture (25% of the frame) of a file filmed with it (sync_clips) is from the same moment, within 0.25 s; J or L cuts under 1 s and slowed or reversed clips pass; the fix retimes the picture's mediaOffset (auto when nothing else depends on it)"),
  rule("text_wrap", "warn", textWrap, "a 1-word title does not wrap and punctuation is never alone on a line (both errors); a 2 or 3 word title that wraps, and a one-word last line under a long line, are warnings"),
  rule("clip_reuse", "warn", clipReuse, "with 4+ clips, one clip fills the frame under 4 times and at most 35% of the video"),
  rule("crop_no_subject", "warn", cropNoSubject, "footage filling the frame and drawn past it (over 8% of the file cut off on a side) has a subject marked (mark_subject); a marked subject less than 85% in the frame is an error"),
  rule("track_lost", "warn", trackLost, "a layer pinned to a track (pin) never follows it through a stretch under 0.5 confidence longer than 0.3 s (the layer holds its last good place there); names the seconds"),
  rule("head_cut_off", "warn", headCutOff, "a person 40% of the picture tall or more keeps their head in the picture: their box touching the top with no head found (or the highest eye or ear at the edge) for 1 s while the clip shows, from filming or from the crop; found by Apple Vision on a Mac in a full check (elsewhere it does not run)"),
  rule("jump_cut", "warn", jumpCut, "back-to-back full-frame shots from one video file (the second at least 0.1 s later in it, framed alike: size within 10%, place within 5%; with pixels, their pictures also alike in framing and light) are joined by a fade, move or blur, or have a different shot between them"),
  rule("source_jump", "warn", sourceJump, "no flash frame or camera jump inside a clip's file within 0.25 s of where it starts or ends on screen (a frame-to-frame change over 10% and 4x the usual; the clip rendered alone, at most 240 frames a check; runs only when check names it, since it costs about 40% of a full check)", true, { askOnly: true }),
  rule("dark_under_title", "warn", darkUnderTitle, "a large title (display or headline role, or 10% of the frame tall) over a clip does not sit on a picture that is near black or flat (luma under 28 or spread under 10) for 60% of its time; a title over a plain card is fine", true),
  rule("low_fps_motion", "warn", lowFpsMotion, "a large clip (20% of the frame) showing under 12 new frames a second (mediaFrameRate, or slowed with nearest frames) does not move on screen, nor show moving footage (with pixels: new frames 3% different)"),
  rule("cut_off_at_rest", "warn", cutOffAtRest, "a picture, clip or device (8% to 70% of the frame) at rest is inside the safe margin or clearly bleeding off, not cut or cramped at the edge"),
  rule("held_static", "warn", heldStatic, "something visibly moves at least every 1.5 s: a clip, an effect, a fade, or a layer moving 1% of the frame diagonal a second (0.4% for a picture filling 30% of it); a still end card over 3 s with no change in sound too, an error over 4.5 s (a slow push alone counts as still) or 5 s silent"),
  rule("frozen_screen", "warn", frozenScreen, "a screenshot filling 8% of the frame or more grows 3% or moves 1.5% of the frame diagonal in every 2.5 s it shows, or something moves over it; the fix pushes into its busiest part (picture facts)"),
  rule("screen_unreadable", "warn", screenUnreadable, "a screenshot is not under 55% of its file width, nor a recording under 2 px a screen point, over 1.5 s without a 1.4x push or a detail crop"),
  rule("off_brand_font", "warn", offBrandFont, "text uses the brand's fonts (set_brand fonts, or fonts the brief names); with none, at most 2 type families"),
  rule("text_on_busy", "warn", textOnBusy, "text is not over fine detail (under 16% edge pixels behind it, scrims included)", true),
  rule("small_on_empty", "warn", smallOnEmpty, "a picture shown on a flat frame fills 25% of it or more (over 1.5 s)", true),
  rule("render_artifact", "warn", renderArtifact, "an RGB split draws no flat saturated slabs (3% of the frame or more)", true),
  rule("speech_captions", "warn", speechCaptions, "captions shown over a voice include every word it says"),
  rule("speech_quotes", "warn", speechQuotes, "captions of heard speech look different from caption-like text nobody says (quotes, another font, style or color)"),
  rule("speech_fragment", "warn", speechFragment, "a sound does not start on the tail (up to 3 words, within 1.5 s) of a sentence said before its in point, unless a voice as loud covers it or its volume is 0.25 or lower; needs a transcript"),
  rule("mute_word", "warn", muteWord, "a ramp of 0.5 s or less that ducks a voice to 35% or less ends 0.03 s before the word it hides, and the ramp back up starts after it (auto when no other word is lowered); end fades and duck_audio dips that do not mute aside"),
  rule("music_stall", "warn", musicStall, "loud music never runs 2.5 s with no cut and no clip at full strength over 40% of the frame"),
  rule("music_turn", "warn", musicTurn, "at a spine turn the music changes: a song section within 0.5 s, 4 dB either way, or a 0.5 s dip just before"),
  rule("music_hard_stop", "warn", musicHardStop, "a song does not stop while loud (last 120 ms within 10 dB of its median, volume 0.08+) with no fade, unless on a cue or beat; fix: fit_music, else a 0.25 s fade (auto)"),
  rule("voice_under_bed", "warn", voiceUnderBed, "each spoken line is 6 LU over the beds under it (music, street sound: sounds of 3 s or more), every 2 words in a row 3 LU (LUFS, voice leveled to -16 as exported, volumes and ducks applied; after a full check measures the files)"),
  rule("bed_jump", "warn", bedJump, "the beds together rise at most 8 LU at an in point or volume step (first 0.1 s after vs 0.3 s before; a 0.2 s fade in passes)"),
  rule("volume_churn", "warn", volumeChurn, "a song or bed turns volume direction (1.5 dB) under 3 times in any 10 s, fades in and out aside"),
  rule("voice_level_spread", "warn", voiceLevelSpread, "spoken lines are heard within 3 dB of each other (measured like voice_under_bed)"),
  rule("end_on_fade", "warn", endOnFade, "the video does not end on a fade while its song is still loud mid-phrase (over 1 s before the file's own ending); an end on a section cue or within a beat of a 4-bar phrase line is fine"),
  rule("no_music", "warn", noMusic, "a video of 10 s or more has music: an audio layer kino hears a beat in, or one playing 30% of the video that is not a transcribed voice; the fix is a soundtrack search when sound search is on, else asking the person at the sound stop"),
  rule("sfx_restraint", "warn", sfxRestraint, "sound effects (sound layers under 3 s that are not music or a voice) play at most 4 in any 16 s (about one every 4 s), and one sound file plays fewer than 3 times; silence is the default and repeated motions play silent after the first"),
  rule("text_load", "warn", textLoad, "texts on screen together ask for at most 24 characters a second (each one's characters ÷ its readable time), and at most 2 separate texts over playing footage for over 1.5 s; a logo, a label shown half the video and the end card do not count"),
  rule("hold", "warn", hold, "text held for its recommended time (Clearcast)"),
  rule("duration_band", "warn", durationBand, "durations in the band for the layer's size (a slow push may be longer)"),
  rule("exit_ratio", "info", exitRatio, "exits 55–75% of the entrance"),
  rule("stagger_long", "warn", staggerLong, "a stagger within 0.5 s"),
  rule("stagger_order", "warn", staggerOrder, "entrances in role order"),
  rule("first_entrance", "warn", firstEntrance, "first entrance 0.1–0.3 s after a cut"),
  rule("easing_repeat", "warn", easingRepeat, "at most 2 motions share an easing and duration"),
  rule("bouncy_layers", "warn", bouncyLayers, "at most one bouncy or elastic layer"),
  rule("scene_lengths", "warn", sceneLengths, "sections not all the same length"),
  rule("no_rhythm", "warn", noRhythm, "a rhythm is declared when there is sound"),
  rule("transitions_dense", "warn", transitionsDense, "at most 2 large transitions per 6 beats"),
  rule("static_scene", "warn", staticScene, "something changes within the hold + 2 s"),
  rule("off_beat", "warn", offBeat, "an accent near a beat lands on it (1 frame to 70 ms off is a near miss; one clearly between beats is syncopation and is left alone)"),
  rule("centered_run", "warn", centeredRun, "not everything centred in 3 sections in a row"),
  rule("card_grid", "warn", cardGrid, "no identical card grids"),
  rule("accent_stripe", "warn", accentStripe, "no left-edge accent stripes"),
  rule("glow_blob_pill", "warn", glowBlobPill, "not glow + blob + pill together"),
  rule("gradient_text", "warn", gradientText, "no gradient text"),
  rule("neon_on_dark", "warn", neonOnDark, "no neon cyan or purple-blue on near-black"),
  rule("pure_frame", "warn", pureFrame, "no full frames of pure #000 or #fff"),
  rule("default_font", "warn", defaultFont, "not a common default font the brand did not choose"),
  rule("gradient_banding", "info", gradientBanding, "no dark full-frame gradient (final renders dither it; drafts and look do not)"),
  rule("speed_jump", "warn", speedJump, "no speed jump over 5% where moves join (place, scale at the corners, rotation); a hold between is fine"),
  rule("transition_dip", "warn", transitionDip, "a dissolve does not fade both shots at once: 85% of the frame stays covered (a fade through black is left alone)"),
  rule("cut_mid_move", "warn", cutMidMove, "a hard cut of large layers does not chop a fast move (0.25 frame widths or 30% scale a second) with the other side still"),
  rule("judder", "warn", judder, "at 30 fps or less, a layer over 20% of the frame pans under 0.14 frame widths a second unless it has motion blur; the fix adds directional-blur keys at a 180 degree shutter while it is fast"),
  rule("own_words", "warn", ownWords, "on-screen words come from the saved sources (when there are any)"),
  rule("stock_copy", "warn", stockCopy, "no stock promo phrases, three-beat slogans or emoji"),
  rule("same_entrance", "warn", sameEntrance, "4+ texts do not all enter with one preset"),
  rule("word_by_word", "warn", wordByWord, "not every text (3+) revealed word by word or letter by letter"),
  rule("soft_cuts", "warn", softCuts, "not a fade or blur at every section change (3+)"),
  rule("blurred_backdrop", "warn", blurredBackdrop, "centered text over blurred full-frame footage on fewer than 3 beats (one designed moment is fine)"),
  rule("text_glow", "warn", textGlow, "no glow on text"),
  rule("stacked_label", "warn", stackedLabel, "no small label stacked right above a headline (a kicker or eyebrow)"),
  rule("fade_only_entrances", "warn", fadeOnlyEntrances, "at most 60% of 5+ entrances only fade"),
  rule("drift_on_every_shot", "warn", driftOnEveryShot, "not every full-frame shot (3+) drifts 0.5% to 5%"),
  rule("even_shot_lengths", "warn", evenShotLengths, "6+ shots: stdev / mean 0.6 or more"),
  rule("split_card_layout", "warn", splitCardLayout, "no 160 px type beside a small framed card on a flat frame for 4 s"),
  rule("page_chrome", "warn", pageChrome, "tracked caps labels under 40 px and rows of thin bars 8 s at most"),
  rule("reference_drift", "warn", referenceDrift, "close to the saved Inspire references in text on screen, and text alone on a plain frame at most twice their share (motion, camera and look advise); needs references and Apple Vision", true),
  rule("reference_closeness", "warn", referenceCloseness, "no run of 6 shots timed like a saved reference (shot lengths in order at one scale, each within a frame, more than chance gives), and in a music edit not every device the studied anime-edit references share (black hole, seam flash, bars, word cards) or 3 of them in their order within 2 s"),
  rule("seen_before", "warn", seenBefore, "type or a logo not laid out as in another kino project (0.12) unless a reference is closer"),
  rule("ending_seen", "warn", endingSeen, "the ending (last 15% or the end beat) not laid out as in another kino project (0.12); only the person waives it"),
  rule("text_slides", "warn", textSlides, "in a video of 8 s or more, text over a still, flat or dimmed background (no clip, no camera move) for at most 25% of it, no card over 3 s and under 3 of 1.2 s+, the end aside"),
  rule("few_techniques", "warn", fewTechniques, "in a video of 8 s or more, not flat: at least one designed device (two from 70 s, at most 4; cut, type-cut, hold, beat-cut and syncopated do not count), repeated as a motif"),
  rule("plain_beats", "warn", plainBeats, "in a video of 8 s or more, the key beats (the hook, the reveal and the payoff: board shots, the payoff inside the spine's payoff beat when there is one, else the first and last 2.5 s) with footage hold a designed technique, not only footage, words and plain cuts, fades, blurs or freezes; plain cuts elsewhere are right. A warning per plain key beat, and a gate at the final render when none of them is designed"),
  rule("technique_repeat", "warn", techniqueRepeat, "monotony only (2 or 3 uses is a motif): a set piece at most 3 times, no non-cut transition on 4+ and 75% of shot changes, a loud accent at most 3 times or once per 15 s, one entrance on under 75% of texts, one slide (same way, distance, size) at most 3 times"),
  rule("metronome", "warn", metronome, "shot lengths spread by 20% or more, and not nearly every cut on the beat at one count"),
  rule("cut_motivation", "warn", cutMotivation, "in a video of 8 cuts or more, at most 40% of cuts fall on no beat (half-beat grid or cue, within a frame), word edge or pause, or moving layer's peak (within 0.1 s)"),
  rule("beat_kick", "warn", beatKick, "at most 5 identical small scale pulses (kicks)"),
  rule("flat_sections", "info", flatSections, "adjacent sections differ in 2 of cut rate, motion, picture and framing scale"),
  rule("style_wanted", "warn", styleWanted, "the techniques the style spec wants (backed by a ref or your words) are used; hard cuts stay free"),
  rule("role_font_drift", "warn", roleFontDrift, "one family per text role (display, stat, subhead, speech, caption; big captions count as display, big numbers as stat; display may use the brand's pair) and one size for captions and speech (within 15%), per voice (a caption track or text color); with style.fonts, the bible's face and size; always a warning"),
  rule("vocabulary_budget", "info", vocabularyBudget, "with style.moves, no designed technique outside the moves (or wants); how many devices and text looks is busy_edit"),
  rule("brand_consistency", "warn", brandConsistency, "one logo treatment (role logo, a layer named logo or mark, or style.logo.asset; a color swap or reveal mask is the same look), shown at most twice, or style.logo.max; always a warning"),
  rule("accent_budget", "warn", accentBudget, "with style.accent, its color (fills, outlines and a gradient's main stop) covers at most its share of the frame for over 1 s"),
  rule("pacing_jump", "info", pacingJump, "median shot length changes at most 3x between neighboring 8 s windows, unless a marker cue, a sound layer's start or end, or a spine beat edge is within 1 s of where the change starts and the new pace holds 12 s"),
  rule("ending_count", "warn", endingCount, "after the last story beat (the spine's, else the last 20%), at most 2 closing beats: logos or display type coming on, 1.5 s apart or more (a caption track running since before is not one; one that starts after it counts once)"),
  rule("template_end", "warn", templateEnd, "a video of 8 s or more does not end on a centered name or logo over a smaller line on a still or darkened frame for 1.5 s"),
  rule("story_stall", "warn", storyStall, "between the first and last 10%, no stretch over 4 s with no picture on a dark frame"),
  rule("hook_readable", "warn", hookReadable, "the first 3 s show type at 8% of the frame's short side or a clear picture (30% of the frame, unblurred) for 1 s"),
  rule("text_only_open", "warn", textOnlyOpen, "in a promo or ad of 8 s or more (videoType, or a logo layer when unset), at most 3 s of the first 4 s show text with no picture (an image or clip on 25% of the frame) and no logo; a text hook over footage is fine"),
  rule("signature_missing", "warn", signatureMissing, "with an idea (style.idea), a signature range (a spine beat with role signature, or signatures[].at) that holds a designed technique, a set piece or a full-frame graphic or footage, and is no shorter than the longest text-only beat; a warning while editing, a gate at the final render", false, { final: true }),
  rule("busy_edit", "info", busyEdit, "in a video of 8 s or more, at most 3 designed devices (moves by name, transitions, camera, set pieces; cuts, holds, fades and slow pushes are plain), designed moves on at most 40% of 5+ shots, at most 2 text looks, and under 3 bright-dark swings of 64 levels between neighbor shots"),
  rule("restraint", "warn", restraint, "transitions only at shot changes, one color grade on a layer at a time (a new look replaces the old), each moment of a footage file shown once (0.5 s overlap), no letterboxed footage (97% of the frame one way, under 90% the other, for 1 s)"),
  rule("request_unmet", "warn", requestUnmet, "each item the person asked for (brief lines and notes) is in the edit: words in quotes on screen, music, voice, captions, a logo, sound effects, an end card ('no X' the other way round); a miss holds the final render, a note with nothing checkable is listed to confirm by looking", false, { final: false }),
  rule("deck_unused", "info", deckUnused, "in a video of 8 s or more, at least half of the project's deck is used (notes deck; a card swapped out does not count)"),
];

// Style rules a backed wanted technique turns off (engine/styleSpec.js): the spec says the video
// does this on purpose. same_entrance and technique_repeat look at the wanted tags themselves.
// Gates never change with the spec.
export const SILENCED_BY = Object.freeze({
  // Wanting blur-through does not silence soft_cuts: a blur on every change is the template look.
  soft_cuts: ["dissolve", "fade-black"],
  word_by_word: ["type-words", "type-letters"],
  blurred_backdrop: ["depth-blur"],
  beat_kick: ["beat-kick"],
  text_slides: ["hold"],
});

export const ruleOf = (code) => RULES.find((entry) => entry.code === code);

// Warnings while editing that block a final render: the edit may be unfinished, the render may not.
export const FINAL_GATES = Object.freeze(RULES.filter((entry) => entry.final).map((entry) => entry.code));
/**
 * True for a finding that blocks a final render (unless waived with a reason). In a real edit
 * (a brief, over 30 layers: `real`, the default) every error and warning blocks; elsewhere (a
 * sketch, a test) errors, FINAL_GATES warnings (signature_missing) and a warning marked final
 * (plain_beats). Advice (info) never blocks.
 */
export const blocksFinal = (finding, real = true) => !finding.waived && (finding.severity === "error"
  || (finding.severity === "warn" && (real || finding.final === true || FINAL_GATES.includes(finding.rule))));

// Advice rules (level info): taste and planning notes, not a defect a viewer sees. Their findings
// come as info, listed in one line and never counted as warnings (a safe auto fix still applies).
function asAdvice(entry, found) {
  if (entry.level !== "info" || !Array.isArray(found)) return found;
  return found.map((finding) => (finding.severity === "warn" ? { ...finding, severity: "info" } : finding));
}

const quote = (text) => {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
};

// ctx.renderFrames that keeps each frame it rendered for this run, so a rule asking for a frame
// another rule already has (text_on_busy reads the contrast frames) gets it without a render.
// Frames are kept by width, the layers left out (or drawn alone, `solo`, over `background`) and the time.
// `nearest(time, within)` gives a kept frame within `within` seconds of `time` (any width, the
// fewest layers left out first), or null: small_on_empty reads the contrast frames that way.
function cachedFrames(render) {
  const kept = new Map();
  const list = [];
  const cached = async (times, options = {}) => {
    const { width, hide = [], solo = null, background = null } = options;
    const prefix = `${width}|${[...hide].sort().join(",")}|${solo ? `solo:${[...solo].sort().join(",")}|${background}|` : ""}`;
    const missing = [...new Set(times.filter((time) => !kept.has(prefix + time)))];
    if (missing.length) {
      const frames = await render(missing, options);
      missing.forEach((time, position) => {
        if (!frames[position]) return;
        kept.set(prefix + time, frames[position]);
        // A solo frame shows only a few layers on a plain color: never a stand-in for the scene.
        if (!solo) list.push({ time, hidden: hide.length, frame: frames[position] });
      });
    }
    return times.map((time) => kept.get(prefix + time));
  };
  cached.nearest = (time, within) => {
    let best = null;
    for (const entry of list)
      if (Math.abs(entry.time - time) <= within && (!best || entry.hidden < best.hidden || (entry.hidden === best.hidden && Math.abs(entry.time - time) < Math.abs(best.time - time)))) best = entry;
    return best?.frame ?? null;
  };
  return cached;
}

function contextFor(model, options) {
  const notes = [];
  const { styleSpec, ...given } = options.context ?? {};
  // context.styleSpec is the brief's saved style spec; the rules read ctx.style (styleContext).
  const style = given.style ?? styleContext(styleSpec);
  if (given.renderFrames) given.renderFrames = cachedFrames(given.renderFrames);
  return {
    name: (item) => (item ? `"${item.name}"` : "a layer"),
    quote,
    sceneName: `"${model.sceneName ?? "the scene"}"`,
    outputFps: 30,
    brandFonts: [],
    ...given,
    style,
    notes,
    note: (text) => { if (!notes.includes(text)) notes.push(text); },
  };
}

// A layer the renderer cannot draw (no src, or a src that is not a kino media path) stops a
// rendered check. That is the layer's problem, not the checker's, so its fix says so.
const LAYER_MEDIA_PROBLEM = /has no src|must use \/api\/media/;

// The backed wanted tags that turn this rule off, or none (the gates are never turned off).
function silencedBy(entry, ctx) {
  if (entry.level === "error" || !ctx.style) return [];
  return (SILENCED_BY[entry.code] ?? []).filter((tag) => ctx.style.backed.includes(tag));
}

// Says once which wanted tags are guessed: shown, but they turn no rule off.
function noteGuessed(ctx) {
  const guessed = ctx.style?.guessed ?? [];
  if (guessed.length)
    ctx.note(`style spec: ${guessed.join(", ")} ${guessed.length === 1 ? "is" : "are"} guessed (not the person's words: no line with ref and at names ${guessed.length === 1 ? "it" : "them"}, and ${guessed.length === 1 ? "it was" : "they were"} copied, dealt or not approved), so ${guessed.length === 1 ? "it turns" : "they turn"} no rule off.`);
}

// A taste warning inside a signature range (styleSpec.js signatureRanges) is the designed
// moment, not a defect: it is dropped there. One that runs on past the range (until) is kept.
function outsideSignatures(entry, found, ctx) {
  const ranges = ctx.style?.signatureRanges ?? [];
  if (!ranges.length || !TASTE_WARNINGS.includes(entry.code) || !Array.isArray(found)) return found;
  const inside = (finding) => Number.isFinite(finding.at)
    && ranges.some(({ from, to }) => finding.at >= from && finding.at <= to && !(Number.isFinite(finding.until) && finding.until > to));
  const kept = found.filter((finding) => !inside(finding));
  if (kept.length < found.length) ctx.note(`${entry.code}: ${found.length - kept.length} inside the signature moment left alone.`);
  return kept;
}

// split_image pieces (a clipping group holding <piece>-px) and the layers beside them in their
// group are an app layout placed on purpose: an auto fix that would move or scale one of them
// (cut_off_at_rest, safe_zone, overlap) is listed for the agent instead of applied (an auto fix
// once moved a camera-view piece onto the next column at 0.969x).
const PLACING = new Set(["move", "transform"]);
function laidOut(model, item) {
  const children = (id) => model.items.filter((entry) => entry.parentId === id);
  const isPiece = (entry) => entry.kind === "group" && children(entry.id).some((child) => child.id === `${entry.id}-px`);
  return chainOf(model, item).some((link) => isPiece(link) || (link.parentId && children(link.parentId).some(isPiece)));
}
function keepLayouts(model, found) {
  if (!Array.isArray(found)) return found;
  for (const finding of found) {
    const fix = finding.fix;
    if (!fix?.auto) continue;
    const ids = fix.kind === "group" ? (fix.changes ?? []).filter((change) => PLACING.has(change.kind)).map((change) => change.itemId) : PLACING.has(fix.kind) ? [fix.itemId] : [];
    const held = ids.map((id) => model.items.find((entry) => entry.id === id)).find((item) => item && laidOut(model, item));
    if (!held) continue;
    finding.fix = { ...fix, auto: false };
    finding.message = `${finding.message} Its fix is not applied: ${held.name ?? held.id} is part of a split_image layout placed on purpose; move it by hand if it should move.`;
  }
  return found;
}

function runOne(entry, model, ctx) {
  const off = silencedBy(entry, ctx);
  if (off.length) {
    ctx.note(`${entry.code} is off: the style spec wants ${off.join(", ")}.`);
    return [];
  }
  try {
    const found = entry.check(model, ctx);
    if (found && typeof found.then === "function") return found.then((list) => asAdvice(entry, keepLayouts(model, outsideSignatures(entry, list, ctx))));
    return asAdvice(entry, keepLayouts(model, outsideSignatures(entry, found, ctx)));
  } catch (error) {
    const text = LAYER_MEDIA_PROBLEM.test(error.message)
      ? "Fix that layer: import its file (project import) and set its src to the /api/media/... address, or delete the layer."
      : "This is a checker problem; report it, or waive the rule.";
    return [{ rule: entry.code, severity: "error", internal: true, message: `The ${entry.code} check could not run: ${error.message}`, fix: { kind: "hint", text } }];
  }
}

/**
 * Runs the rules on a model. `codes` limits them to those rule codes; `pixels: false` skips the
 * rules that render frames. Resolves to {findings, notes, ms}; findings come in rule order.
 */
export async function runQuality(model, { codes = null, pixels = true, context = {} } = {}) {
  const started = performance.now();
  const ctx = contextFor(model, { context });
  const chosen = RULES.filter((entry) => (codes ? codes.includes(entry.code) : !entry.askOnly) && (pixels || !entry.pixels));
  noteGuessed(ctx);
  const findings = [];
  for (const entry of chosen) {
    let found = runOne(entry, model, ctx);
    if (found && typeof found.then === "function") found = await found.catch((error) => runOne({ ...entry, check: () => { throw error; } }, model, ctx));
    findings.push(...(found ?? []));
  }
  // Times to the hundredth once here, so a 30 fps time reads 3.17, not 3.1666666666666665.
  for (const finding of findings) for (const key of ["at", "until"]) if (Number.isFinite(finding[key])) finding[key] = sec(finding[key]);
  return { findings, notes: ctx.notes, ms: Math.round(performance.now() - started) };
}

/** The data rules only, synchronously (for edit receipts). */
export function runDataQuality(model, { codes = null, context = {} } = {}) {
  const ctx = contextFor(model, { context });
  noteGuessed(ctx);
  const findings = [];
  for (const entry of RULES) {
    if (entry.pixels || (codes && !codes.includes(entry.code))) continue;
    findings.push(...(runOne(entry, model, ctx) ?? []));
  }
  return { findings, notes: ctx.notes };
}
