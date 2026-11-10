// The edit ops for a footage plan (plan.js): plain kino ops (add_layer, group_layers,
// add_animation, duck_audio) and building blocks (move, recipe), in the order they stack:
// shots, transitions, hits, title, captions, end card, sound. compose {footage} runs them as one
// edit, so every layer is a normal layer an agent can change afterwards.
//
// Names: shot-N is a shot (a video, or a group of its parts: shot-N-clip, shot-N-blur,
// shot-N-behind); sound-N a shot's sound when it lives in its own file; music, voice; said-N the
// captions of shot N; title; end-card; flash-N and hit-N on the beats; Accent on a shot is a
// downbeat zoom punch (compose {footage, accents:true}, engine/footage/pace.js).
import { round as round3 } from "../numbers.js";

const show = (start) => ({ kind: "show", start: round3(Math.max(0, start)) });
const hide = (start) => ({ kind: "hide", start: round3(start) });
const custom = (name, start, duration, from, to, easing = "smooth") => ({ kind: "custom", name, start: round3(Math.max(0, start)), duration: round3(Math.max(0.02, duration)), easing, from, to });
const scaleBy = (value) => ({ scaleX: round3(value), scaleY: round3(value) });

// When a transition's move starts, before the cut at `at` (the moves' own timing, engine/blocks/moves/transitions.js).
const MOVE_LEAD = { "zoom-through": 0.5, "whip-pan": 0.25, "mask-through-shape": 0.2 };

const SONG_KIND = /^[a-z]+(?:-[a-z]+)?$/;

/**
 * The cues a plan leaves in the document (compose adds them after its ops; set_cues cannot write
 * fitted ones): the song's seams and rests as fitted markers song-<kind>-<n> (the names fit_music
 * uses, in time order), so seam_lock, rest_fit and impact-accent see the sections the cuts were
 * locked to; and a marker for the end card, the named moment its text starts on. A plan with no
 * song shape gives no song cues. `suffix` marks a second footage scene: it keeps only its own
 * end-card marker (the song cues belong to the first one). `endCardStart` is when the end card's
 * first entrance starts in the built scene; the plan's own time (the recipe leads by 0.1 s) is the fallback.
 */
export function footageCues(plan, { suffix = "", endCardStart = null } = {}) {
  const cues = [];
  if (plan.song && !suffix) {
    const marks = plan.song.seams.map((seam) => ({ at: seam.at, kind: seam.kind, weight: seam.weight }));
    // A rest starts at its dropout, which the cut seams leave out; it counts when its return is here.
    for (const rest of plan.song.rests) {
      if (rest.from > 0 && marks.some((mark) => Math.abs(mark.at - rest.to) < 1e-3) && !marks.some((mark) => Math.abs(mark.at - rest.from) < 1e-3)) marks.push({ at: rest.from, kind: "dropout" });
    }
    const counts = {};
    for (const mark of marks.filter((entry) => SONG_KIND.test(entry.kind)).sort((a, b) => a.at - b.at)) {
      counts[mark.kind] = (counts[mark.kind] ?? 0) + 1;
      cues.push({ name: `song-${mark.kind}-${counts[mark.kind]}`, time: round3(mark.at), kind: "marker", fitted: true, ...(mark.weight >= 0 && mark.weight <= 1 ? { weight: mark.weight } : {}) });
    }
  }
  if (plan.endCard.text) cues.push({ name: `end-card${suffix}`, time: round3(Math.min(plan.duration, endCardStart ?? plan.endCard.at + 0.2)), kind: "marker" });
  return cues;
}

/** How far a shot's picture shows before its start and after its end, for the transitions. */
function handles(plan) {
  const before = new Map(), after = new Map();
  plan.shots.forEach((shot, index) => {
    const into = shot.transition;
    const previous = plan.shots[index - 1];
    if (!into || !previous) return;
    let lead = 0, tail = 0;
    if (into.move) { lead = MOVE_LEAD[into.move]; tail = into.length - lead; }
    else if (into.kind === "dissolve" || into.kind === "push-transition") { lead = into.length / 2; tail = into.length / 2; }
    before.set(shot.n, lead);
    after.set(previous.n, tail);
  });
  return { before: (shot) => before.get(shot.n) ?? 0, after: (shot) => after.get(shot.n) ?? 0 };
}

/**
 * Ops for a plan. `clips` maps clip keys to {src, duration, name, sound:{src, own, duration}};
 * `scene` is added to every op when the project has more than one scene.
 */
export function footageOps(plan, clips, { scene = null } = {}) {
  const ops = [];
  const where = scene ? { scene } : {};
  const push = (op) => ops.push({ ...op, ...where });
  const { width: W, height: H } = plan.frame;
  const handle = handles(plan);
  const speechLayers = [];
  const shotName = (shot) => `shot-${shot.n}`;
  // The top-level layers of a shot: one (a video or a group), or a loose card over its blurred copy.
  const partsOf = (shot) => (shot.layout.loose ? [`shot-${shot.n}-blur`, `shot-${shot.n}`] : [`shot-${shot.n}`]);
  const moveOut = (shot) => {
    const next = plan.shots[shot.n];
    return next?.transition?.move ? MOVE_LEAD[next.transition.move] : 0;
  };

  for (const shot of plan.shots) {
    const clip = clips.get(shot.clip);
    const lead = handle.before(shot);
    const tail = handle.after(shot);
    const visibleFrom = round3(Math.max(0, shot.start - lead));
    const visibleTo = round3(Math.min(plan.duration, shot.end + tail));
    const offset = round3(Math.max(0, shot.in - (shot.start - visibleFrom)));
    const play = round3(visibleTo - visibleFrom);
    const media = (src, duration, fileIn = offset) => ({ src, mediaSourceDuration: duration, mediaStart: visibleFrom, mediaOffset: round3(Math.min(fileIn, Math.max(0, duration - 0.05))), mediaDuration: play, mediaFreeze: "both" });
    const speechEnd = shot.speech ? round3(shot.start + (shot.moment.out - shot.in)) : null;
    const ownSound = shot.speech && clip.sound?.own;
    const volume = shot.volume ?? 1;
    // The clip's own sound, cut at the word edges with 30 ms fades.
    const soundAnimations = ownSound ? [custom("Sound in", shot.start, 0.03, { volume: 0 }, { volume }, "linear"), custom("Sound out", speechEnd - 0.03, 0.03, { volume }, { volume: 0 }, "linear")] : [];
    const camera = [];
    const layout = shot.layout;
    const id = shotName(shot);
    // Camera moves run between the transitions' moves.
    const camFrom = round3(shot.start + (shot.transition?.move || shot.transition?.kind === "title" ? 0.45 : 0));
    const camTo = round3(Math.max(camFrom + 0.5, shot.end - moveOut(shot)));
    const cam = shot.camera ?? { kind: "slow-push", amount: 0.04, direction: 1 };
    const speedKeys = [];
    if (shot.ramp) speedKeys.push(custom("Slow motion", shot.ramp.at, 0.4, { speed: 1 }, { speed: shot.ramp.to }));
    if (shot.freezeAt !== undefined) speedKeys.push(custom("Freeze", shot.freezeAt - 0.05, 0.1, { speed: shot.ramp?.to ?? 1 }, { speed: 0 }));
    // A shot too short to hold still gets no camera move (it is gone before a move reads).
    const still = camTo - camFrom < 1.5;
    const cameraOn = (box, factor = 1) => {
      if (still) return [];
      if (cam.kind === "drift") {
        const dx = round3(cam.direction * 0.025 * W * factor);
        return [custom("Drift", camFrom, camTo - camFrom, { x: box.x, ...scaleBy(1.06) }, { x: round3(box.x + dx), ...scaleBy(1.06) })];
      }
      return [custom("Slow push", camFrom, camTo - camFrom, scaleBy(1), scaleBy(1 + cam.amount * factor))];
    };
    // The push-through-type title's dark card sits under the title's shot (the word goes just below it).
    if (shot.n === 2 && plan.title?.kind === "push-through-type") push({ op: "add_layer", layerType: "rectangle", name: "title-card", properties: { x: 0, y: 0, width: W, height: H, fill: "#0A0A0C" },
      animations: [show(plan.title.at), hide(plan.title.at + plan.title.dur)] });
    // Downbeat accents (plan.js): a zoom punch from the scale the camera holds (a drift's 1.06, else 1) and back.
    // The names mark them: duration_band reads "Accent" and "Accent settles" as quick on purpose.
    const accentsFrom = (base) => (shot.accents ?? []).flatMap((at) => [custom("Accent", at - 0.04, 0.08, scaleBy(base), scaleBy(base * 1.06), "ease-out"), custom("Accent settles", at + 0.04, 0.3, scaleBy(base * 1.06), scaleBy(base), "ease-out")]);
    if (layout.kind === "fill") {
      camera.push(...cameraOn(layout.main));
      push({ op: "add_layer", layerType: "video", name: id, properties: { ...layout.main, ...media(clip.src, clip.duration), volume: 0, ...(shot.ramp?.blend ? { mediaInterpolation: "blend" } : {}) },
        animations: [show(visibleFrom), hide(visibleTo), ...camera, ...soundAnimations, ...speedKeys, ...accentsFrom(!still && cam.kind === "drift" ? 1.06 : 1)] });
    } else {
      const parts = [];
      if (layout.kind === "blur-fill") {
        const back = layout.backdrop;
        push({ op: "add_layer", layerType: "video", name: `${id}-blur`, properties: { x: back.x, y: back.y, width: back.width, height: back.height, ...media(clip.src, clip.duration), volume: 0, blur: back.blur, opacity: back.opacity },
          animations: [...(layout.loose ? [show(visibleFrom), hide(visibleTo)] : []), ...speedKeys, ...(still ? [] : [custom("Drift", camFrom, camTo - camFrom, { x: back.x }, { x: round3(back.x + cam.direction * 0.012 * W) })])] });
        parts.push(`${id}-blur`);
      } else {
        const behind = clips.get(layout.partner.clip);
        const box = layout.partner.box;
        const partnerIn = round3(layout.partner.in);
        push({ op: "add_layer", layerType: "video", name: `${id}-behind`, properties: { ...box, ...media(behind.src, behind.duration, partnerIn), volume: 0, blur: Math.round(0.004 * Math.max(W, H)), opacity: 0.75 },
          animations: still ? [] : [custom("Push in", camFrom, camTo - camFrom, scaleBy(1), scaleBy(1.05))] });
        parts.push(`${id}-behind`);
      }
      const card = layout.main;
      push({ op: "add_layer", layerType: "video", name: layout.loose ? id : `${id}-clip`, properties: { ...card, ...media(clip.src, clip.duration), volume: 0, radius: layout.radius, shadow: { color: "#000000B3", x: 0, y: Math.round(0.02 * H), blur: Math.round(0.05 * H) } },
        animations: [...(layout.loose ? [show(visibleFrom), hide(visibleTo)] : []), ...soundAnimations, ...speedKeys, ...(
          // The card drifts toward the middle of the frame, so it never leaves the safe area.
          still ? [] : [custom("Drift closer", camFrom, camTo - camFrom, { x: card.x, ...scaleBy(1) }, { x: round3(card.x + Math.sign(W / 2 - (card.x + card.width / 2) || cam.direction) * Math.min(0.02 * W, Math.abs(W / 2 - (card.x + card.width / 2)) || 0.01 * W)), ...scaleBy(1.02) })])] });
      if (!layout.loose) {
        parts.push(`${id}-clip`);
        push({ op: "group_layers", layers: parts, name: id });
        push({ op: "add_animation", layer: id, animation: show(visibleFrom) });
        push({ op: "add_animation", layer: id, animation: hide(visibleTo) });
        for (const animation of accentsFrom(1)) push({ op: "add_animation", layer: id, animation });
      }
    }
    if (ownSound) speechLayers.push(layout.kind === "fill" || layout.loose ? id : `${id}-clip`);
    // The sound of a picture-only clip that has its own sound file (a phone's video and its audio).
    if (shot.speech && clip.sound && !clip.sound.own) {
      const name = `sound-${shot.n}`;
      push({ op: "add_layer", layerType: "audio", name, properties: { src: clip.sound.src, mediaSourceDuration: clip.sound.duration, mediaStart: shot.start, mediaOffset: shot.in, mediaDuration: round3(speechEnd - shot.start), volume },
        animations: [custom("Sound in", shot.start, 0.03, { volume: 0 }, { volume }, "linear"), custom("Sound out", speechEnd - 0.03, 0.03, { volume }, { volume: 0 }, "linear")] });
      speechLayers.push(name);
    }
  }

  // ---- transitions --------------------------------------------------------------------------
  for (const shot of plan.shots) {
    const into = shot.transition;
    const previous = plan.shots[shot.n - 2];
    if (!into || !previous || ["cut", "title"].includes(into.kind)) continue;
    const from = shotName(previous), to = shotName(shot);
    const at = into.at;
    if (into.move) {
      const start = round3(at - MOVE_LEAD[into.move]);
      const point = shot.focus ? [Math.round(shot.focus[0] * 100), Math.round(shot.focus[1] * 100)] : undefined;
      const fields = into.move === "mask-through-shape" ? { to, from, ...(point ? { point } : {}) } : into.move === "zoom-through" ? { from, to, ...(previous.focus ? { point: [Math.round(previous.focus[0] * 100), Math.round(previous.focus[1] * 100)] } : {}) } : { from, to };
      push({ op: "move", name: into.move, id: `cut-${shot.n}`, at: start, dur: into.length, seed: shot.n, ...fields });
      continue;
    }
    const half = into.length / 2;
    const both = (layers, animation) => { for (const layer of layers) push({ op: "add_animation", layer, animation: { ...animation } }); };
    // A loose shot's blurred copy is already see-through: it fades from 0 to its own opacity.
    const fadeTo = (layer, value) => (layer.endsWith("-blur") ? (plan.shots.find((entry) => `shot-${entry.n}-blur` === layer)?.layout.backdrop?.opacity ?? value) : value);
    // Shot changes are custom fades, not entrances: an entrance is for words and graphics.
    if (into.kind === "dissolve") for (const layer of partsOf(shot)) push({ op: "add_animation", layer, animation: custom("Dissolve in", at - half, into.length, { opacity: 0 }, { opacity: fadeTo(layer, 1) }) });
    else if (into.kind === "fade-black") {
      for (const layer of partsOf(previous)) push({ op: "add_animation", layer, animation: custom("Fade to black", at - half, half, { opacity: fadeTo(layer, 1) }, { opacity: 0 }, "ease-in") });
      for (const layer of partsOf(shot)) push({ op: "add_animation", layer, animation: custom("Fade up", at, half, { opacity: 0 }, { opacity: fadeTo(layer, 1) }, "ease-out") });
    } else if (into.kind === "blur-through") {
      const amount = Math.round(0.025 * Math.max(W, H));
      both(partsOf(previous).filter((layer) => !layer.endsWith("-blur")), custom("Blur out", at - half, half, { blur: 0 }, { blur: amount }, "ease-in"));
      both(partsOf(shot).filter((layer) => !layer.endsWith("-blur")), custom("Blur in", at, half, { blur: amount }, { blur: 0 }, "ease-out"));
    } else if (into.kind === "flash") {
      // Sized by the leaving shot's brightness (plan.js flashPeak).
      const peak = into.peak ?? 0.9;
      push({ op: "add_layer", layerType: "rectangle", name: `flash-${shot.n}`, properties: { x: 0, y: 0, width: W, height: H, fill: "#FFFFFF", opacity: 0 },
        animations: [show(at - 0.08), custom("Flash", at - 0.08, 0.08, { opacity: 0 }, { opacity: peak }, "ease-in"), custom("Flash fades", at, 0.2, { opacity: peak }, { opacity: 0 }, "ease-out"), hide(at + 0.22)] });
    } else if (into.kind === "glitch-hit") {
      // The leaving shot glitches out into the cut (a glitch on the new one would be an entrance).
      push({ op: "add_animation", layer: from, preset: "preset-glitch", mode: "out", start: round3(at - 0.45), duration: 0.45 });
    } else if (into.kind === "push-transition") {
      const fromBox = previous.layout.kind === "fill" ? previous.layout.main : (previous.layout.backdrop ?? previous.layout.partner.box);
      const toBox = shot.layout.kind === "fill" ? shot.layout.main : (shot.layout.backdrop ?? shot.layout.partner.box);
      // The way the incoming footage moves, measured (plan.js), else one steady way.
      const direction = into.direction ?? -1;
      push({ op: "add_animation", layer: from, animation: custom("Pushed off", at - half, into.length, { x: fromBox.x }, { x: round3(fromBox.x + direction * W) }, "ease-in-out") });
      push({ op: "add_animation", layer: to, animation: custom("Pushed in", at - half, into.length, { x: round3(toBox.x - direction * W) }, { x: toBox.x }, "ease-in-out") });
    }
  }

  // ---- hits on the beat ----------------------------------------------------------------------
  plan.hits.forEach((hit, index) => {
    if (hit.kind === "rgb-split") push({ op: "move", name: "rgb-split-hit", id: `hit-${index + 1}`, layer: `shot-${hit.shot}`, at: hit.at, strength: hit.strength ?? 0.45 });
    else if (hit.kind === "flash" && !plan.shots.some((shot) => shot.transition?.kind === "flash" && Math.abs(shot.transition.at - hit.at) < 0.5)) {
      const peak = hit.peak ?? 0.85;
      push({ op: "add_layer", layerType: "rectangle", name: `flash-hit-${index + 1}`, properties: { x: 0, y: 0, width: W, height: H, fill: "#FFFFFF", opacity: 0 },
        animations: [show(hit.at - 0.05), custom("Flash", hit.at - 0.05, 0.05, { opacity: 0 }, { opacity: peak }, "ease-in"), custom("Flash fades", hit.at, 0.22, { opacity: peak }, { opacity: 0 }, "ease-out"), hide(hit.at + 0.25)] });
    }
  });
  if (plan.setPiece?.name === "tile-ring") {
    const others = [...new Set(plan.shots.filter((shot) => shot.n !== plan.setPiece.shot).map((shot) => clips.get(shot.clip).mediaId).filter(Boolean))].slice(0, 6);
    push({ op: "move", name: "tile-ring", id: "tile-ring", layer: `shot-${plan.setPiece.shot}`, at: plan.setPiece.at, dur: plan.setPiece.dur, ending: "fade", ...(others.length ? { pictures: others } : {}) });
  }

  // ---- sound (first, so the title and captions know the beat) ------------------------------------------------------------------------------
  if (plan.voice) {
    push({ op: "add_layer", layerType: "audio", name: "voice", properties: { src: plan.voice.src, mediaSourceDuration: plan.voice.duration, mediaStart: plan.voice.start, mediaOffset: 0, mediaDuration: round3(Math.min(plan.voice.duration, plan.duration - plan.voice.start)), volume: 1 } });
    speechLayers.push("voice");
  }
  if (plan.music) {
    const music = plan.music;
    const length = round3(Math.min(plan.duration - music.start, music.duration - music.offset));
    const level = music.volume;
    push({ op: "add_layer", layerType: "audio", name: "music", properties: { src: music.src, mediaSourceDuration: music.duration, mediaStart: music.start, mediaOffset: music.offset, mediaDuration: length, volume: level },
      animations: [{ kind: "in", name: "Music in", start: music.start, duration: 0.6, easing: "ease-out", from: { volume: 0 }, to: { volume: level } },
        { kind: "out", name: "Music out", start: round3(music.start + length - 1.8), duration: 1.8, easing: "ease-in", from: { volume: level }, to: { volume: 0 } }] });
    if (speechLayers.length) push({ op: "duck_audio", layer: "music", under: speechLayers, to: music.under, fade: 0.25 });
    // The song's beats become the project's rhythm and beat cues, so check can judge the cutting.
    push({ op: "detect_beats", layer: "music" });
  }

  // ---- the title, the captions and the end card ----------------------------------------------
  if (plan.title) {
    if (plan.title.kind === "push-through-type") push({ op: "move", name: "push-through-type", id: "title", text: plan.title.text, next: `shot-${plan.title.over}`, at: plan.title.at, dur: plan.title.dur });
    else push({ op: "recipe", name: "headline-reveal", id: "title", text: plan.title.text, at: round3(plan.title.at + 0.1), dur: round3(plan.title.dur + 0.4), enter: plan.title.enter });
  }
  plan.captions.forEach((caption, index) => {
    // A shot's captions end with the shot (the last one does not hold over the next shot).
    const until = caption.until ?? null;
    push({ op: "move", name: "caption-words", id: caption.voice ? "said-voice" : `said-${caption.shot ?? index + 1}`, at: caption.words[0].at, words: caption.words, energy: caption.energy, ...(until ? { dur: round3(until - caption.words[0].at) } : {}) });
  });
  const last = plan.shots.at(-1);
  if (plan.endCard.text) {
    // The last shot softens and darkens under the end card.
    for (const layer of partsOf(last).filter((name) => !name.endsWith("-blur")))
      push({ op: "add_animation", layer, animation: custom("Soften for the end", plan.endCard.at - 0.2, 0.7, { blur: 0, opacity: 1 }, { blur: Math.round(0.012 * Math.max(W, H)), opacity: 0.4 }, "ease-out") });
    // The title as a wordmark, with the end line under it.
    push({ op: "recipe", name: "logo-sting", id: "end-card", text: plan.endCard.text, ...(plan.endCard.sub ? { tagline: plan.endCard.sub } : {}), at: round3(plan.endCard.at + 0.1) });
  }
  return ops;
}
