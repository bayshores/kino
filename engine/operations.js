import { animationProblem, createLayer, createScene, parseDocument, uid } from "./model.js";
import { withTextStyleRange } from "./textStyleRanges.js";
import { patchTextLayer } from "./textStyleEdits.js";
import { resizeTextLayer } from "./textLayout.js";
import { assertAxesInRange, mergeAxes } from "./fontAxes.js";
import { isEffectivelyLocked } from "./layerTree.js";
import { boxStylePatch } from "./boxStyles.js";
import { nextScenePosition } from "./sceneLayout.js";
import { duplicateSceneInDocument } from "./sceneDuplication.js";
import { presetAnimation, resolveAnimationInitialValue } from "./animation.js";
import { followEntrance, showBeforeEntrance } from "./entranceHide.js";
import { fitNewText } from "./textFit.js";
import { effectDefinition } from "./effects/catalog.js";
import { createComponentInstance, detachComponent } from "./linkedComponents.js";
import { createComponentFromLayers } from "./createComponent.js";
import { convertLayerToShape } from "./shapeConversion.js";
import { outlineTextLayers } from "./outlineText.js";
import { ALIGNMENT_IDS, alignLayers, alignmentFrame } from "./arrange.js";
import { groupLayers, ungroupLayers } from "./grouping.js";
import { createMask, removeMasks } from "./masking.js";
import { moveLayers, ORDER_MOVES, reorderLayers, setLayerFlags } from "./layerOrder.js";
import { editLayers, updateLayersEdit } from "./multiEdit.js";
import { movePresetAnimations } from "./presetMove.js";
import { followClipTiming } from "./cutoutTiming.js";
import { MAX_VOLUME } from "./mediaTime.js";
import { animationListProblem, sceneAnimationProblem } from "./animationListCheck.js";
import { animationTreeEntries, editAnimationTree } from "./animationTree.js";
import { composeAnimations, convertSceneAnimations, duplicateAnimations, ungroupAnimations } from "./animationComposition.js";
import { editSceneAnimations } from "./sceneAnimationEdit.js";
import { operationStaggerItems, staggerPlan } from "./stagger.js";
import { enabledValueProblem } from "./animationEnabled.js";
import {
  componentOverridesWithPatch,
  componentOverridesWithout,
  componentPathProblem,
  MAX_OVERRIDES_PER_INSTANCE,
} from "./componentOverrides.js";
import { animationOwners, backgroundAnimationProblem } from "./sceneBackground.js";
import { parseCsv } from "./csv.js";
import { applyBulkCreate, planBulkCreate } from "./bulkCreate.js";
import { applyProjectUpdate, keptWaivers, withWaiver, withoutWaiver } from "./projectSettings.js";
import { assertReplacementKeepsOverrides, layerWithReplacementMedia, mediaIdFromSource } from "./replaceMedia.js";
import { applyAudioCaptionOperation } from "./audioCaptionOperations.js";
import { colorFilterSteps } from "./colorFilter.js";
import { RESIZE_ANCHORS } from "./resizeAnchor.js";
import { refreshBehaviorLinks } from "./behaviorLinks.js";
import { frameShot } from "./footage/layout.js";
import { normalizeLetterbox, normalizeSceneFinish } from "./sceneFinishFields.js";

// A Color animation (`fill` in from or to) only draws on a layer that has a Fill (paints.js).
// Every operation that adds one or changes its fill values refuses it on a layer without a Fill:
// add_animation, update_animation(s), and add_layer or update_layer with `animations`. An older
// one already in the document still opens and keeps its timing edits. parseDocument checks the
// paints themselves at the end (hex colors, 2 to 64 ordered stops).
// add_layer, update_layer and insert_component set a whole animation list at once, and add_scene
// and update_scene with `layers` set every layer's list; they run the same Color, Resize, and Hide
// and Show checks as add_animation on each animation (animationListCheck.js).
// update_animation(s) take `enabled` as true or false and refuse any other value: false turns the
// animation off for playback and true turns it on again (animationEnabled.js). parseDocument
// drops `enabled: true`, so an animation that is on is saved without the field.

export function applyOperations(source, operations, {fonts, mediaBySrc, mediaById, reports, soundLevels} = {}) {
  if (!Array.isArray(operations) || operations.length > 1000)
    throw new Error("Provide an array of at most 1000 editing operations.");
  const document = structuredClone(source);
  for (const operation of operations) {
    if (!operation || typeof operation !== "object")
      throw new Error("Each operation must be an object.");
    if (operation.type === "rename_project") {
      document.name = operation.name;
      continue;
    }
    if (operation.type === "update_project") {
      applyProjectUpdate(document, operation.properties);
      continue;
    }
    if (operation.type === "waive_check") {
      document.checkWaivers = withWaiver(document.checkWaivers, operation);
      continue;
    }
    // color_filter: a named look made of ordinary Color effects (colorFilter.js).
    if (operation.type === "color_filter") {
      const filtered = applyOperations(document, colorFilterSteps(document, operation), { fonts, mediaBySrc, mediaById, soundLevels });
      document.scenes = filtered.scenes;
      continue;
    }
    if (operation.type === "unwaive_check") {
      document.checkWaivers = withoutWaiver(document.checkWaivers, operation);
      continue;
    }
    if (operation.type === "add_scene") {
      // A scene drifts through its holds only when asked (properties.drift, engine/camera.js).
      const added = createScene({ ...nextScenePosition(document.scenes), ...operation.properties });
      if (!added.drift) delete added.drift;
      const problem = backgroundAnimationProblem(added) || sceneAnimationProblem(added, []);
      if (problem) throw new Error(problem);
      document.scenes.push(added);
      continue;
    }
    if (operation.type === "create_component_from_layers") {
      const next = createComponentFromLayers(document, operation.sceneId, operation.layerIds, {
        name: operation.name, componentSceneId: operation.componentSceneId, instanceId: operation.instanceId, fonts,
      });
      document.scenes = next.document.scenes;
      continue;
    }
    // Cues, captions, beats, sequences and ducking (audioCaptionOperations.js); reports go to the agent.
    if (operation.type === "set_cues" || operation.type === "add_captions" || operation.type === "detect_beats" || operation.type === "add_sequence" || operation.type === "cut_speech" || operation.type === "sync_clips" ||
      operation.type === "duck_audio" || operation.type === "fit_music" || operation.type === "place_broll" || operation.type === "keep_line") {
      applyAudioCaptionOperation(document, operation, { fonts, reports });
      continue;
    }
    const scene = document.scenes.find((s) => s.id === operation.sceneId);
    if (!scene) throw new Error(`Scene ${operation.sceneId} was not found.`);
    if (operation.type === "duplicate_scene") {
      document.scenes = duplicateSceneInDocument(document, scene.id).document.scenes;
      continue;
    }
    if (operation.type === "bulk_create") {
      if (operation.deleteMissing !== undefined && typeof operation.deleteMissing !== "boolean")
        throw new Error("bulk_create deleteMissing must be true or false.");
      if ((operation.csv !== undefined) === (operation.rows !== undefined))
        throw new Error("bulk_create needs either CSV text or rows including the header as the first row.");
      let parsed;
      if (operation.csv !== undefined) parsed = parseCsv(operation.csv);
      else {
        if (!Array.isArray(operation.rows) || !operation.rows.length)
          throw new Error("bulk_create rows must include the header as the first row.");
        parsed = { header: operation.rows[0], rows: operation.rows.slice(1) };
      }
      // MCP imports media separately with import_media. Filenames are row errors here; only
      // the editor's upload phase has local image files to resolve before this pure operation.
      const plan = planBulkCreate(document, scene.id, parsed.header, parsed.rows, [], mediaBySrc ?? {});
      const next = applyBulkCreate(document, plan, mediaBySrc ?? {}, { deleteMissing: operation.deleteMissing ?? false });
      document.scenes = next.scenes;
      continue;
    }
    if (operation.type === "update_scene") {
      const previous = { ...scene };
      const previousLayers = scene.layers;
      Object.assign(scene, operation.properties, { id: scene.id });
      // finish and letterbox are checked now and saved in their plain form (true is the starting
      // point's numbers; false, null or 0 removes them), so a wrong value is refused on this call.
      const refuse = (path, message) => { throw new Error(`update_scene ${path} ${message}`); };
      if (operation.properties && Object.hasOwn(operation.properties, "finish")) {
        scene.finish = normalizeSceneFinish(scene.finish, "properties.finish", refuse);
        if (scene.finish === undefined) delete scene.finish;
      }
      if (operation.properties && Object.hasOwn(operation.properties, "letterbox")) {
        scene.letterbox = normalizeLetterbox(scene.letterbox, "properties.letterbox", refuse);
        if (scene.letterbox === undefined) delete scene.letterbox;
      }
      const problem = backgroundAnimationProblem(scene, previous) || sceneAnimationProblem(scene, previousLayers);
      if (problem) throw new Error(problem);
      continue;
    }
    if (operation.type === "create_component") {
      scene.isComponent = true;
      continue;
    }
    if (operation.type === "insert_component") {
      const sourceScene = document.scenes.find((s) => s.id === operation.componentSceneId);
      const instance = createComponentInstance(sourceScene, operation.properties || {});
      const problem = animationListProblem(instance, [], scene.duration);
      if (problem) throw new Error(problem);
      scene.layers.push(instance);
      continue;
    }
    if (operation.type === "detach_component") {
      const next = detachComponent(document, scene.id, operation.layerId, {fonts});
      document.scenes = next.scenes;
      continue;
    }
    if (operation.type === "delete_scene") {
      if (document.scenes.length === 1)
        throw new Error("A document needs at least one scene.");
      document.scenes = document.scenes.filter((s) => s !== scene);
      continue;
    }
    if (operation.type === "add_layer") {
      const properties = operation.properties || {};
      const added = fitNewText(createLayer(operation.layerType, properties), properties, scene, fonts);
      validatePathFillRule([added], properties, "add_layer");
      validateMaskFields([added], properties, "add_layer");
      const problem = animationListProblem(added, [], scene.duration);
      if (problem) throw new Error(problem);
      // Footage goes under a status-line badge on top of the stack (a small overlay that stays
      // seen), so the agent never has to move the badge back above a clip it adds later.
      let at = scene.layers.length;
      if (added.type === "video" || added.type === "image") while (at > 0 && scene.layers[at - 1].move?.name === "status-line") at -= 1;
      scene.layers.splice(at, 0, added);
      continue;
    }
    if (operation.type === "align_layers") {
      alignSceneLayers(document, scene, operation, fonts);
      continue;
    }
    if (operation.type === "group_layers") {
      groupSceneLayers(document, scene, operation, fonts);
      continue;
    }
    if (operation.type === "create_mask") {
      createSceneMask(document, scene, operation, fonts);
      continue;
    }
    // remove_mask { sceneId, layerId }: the same as ⌃⌘M on a mask group (masking.js removeMasks).
    if (operation.type === "remove_mask") {
      if (typeof operation.layerId !== "string")
        throw new Error("remove_mask needs layerId: the ID of a mask group.");
      scene.layers = removeMasks(document, scene.id, [operation.layerId], {fonts}).layers;
      continue;
    }
    if (operation.type === "ungroup_layer") {
      if (typeof operation.layerId !== "string")
        throw new Error("ungroup_layer needs layerId: the ID of a group layer.");
      scene.layers = ungroupLayers(document, scene.id, [operation.layerId], {fonts}).layers;
      continue;
    }
    if (operation.type === "reorder_layer") {
      reorderSceneLayer(scene, operation);
      continue;
    }
    if (operation.type === "set_layer_flags") {
      setSceneLayerFlags(scene, operation);
      continue;
    }
    if (operation.type === "move_layers") {
      moveSceneLayers(document, scene, operation, fonts);
      continue;
    }
    if (operation.type === "update_layers") {
      updateSceneLayers(document, scene, operation, fonts, reports);
      continue;
    }
    if (operation.type === "update_animations") {
      updateSceneAnimations(scene, operation, { document, fonts });
      continue;
    }
    if (operation.type === "group_animations") {
      const animationIds = operationAnimationIds(operation, "group_animations");
      const name = operation.name === undefined ? undefined : operationAnimationName(operation.name, "group_animations");
      assertSceneAnimationIds(scene, animationIds, "group_animations");
      assertNoAncestorAnimationSelection(scene, animationIds, "group_animations");
      const result = composeAnimations(document, scene.id, animationIds, name === undefined ? undefined : { name });
      document.scenes = result.document.scenes;
      continue;
    }
    if (operation.type === "ungroup_animations") {
      const animationIds = operationAnimationIds(operation, "ungroup_animations");
      assertSceneAnimationIds(scene, animationIds, "ungroup_animations");
      assertNoAncestorAnimationSelection(scene, animationIds, "ungroup_animations");
      const result = ungroupAnimations(document, scene.id, animationIds);
      document.scenes = result.document.scenes;
      continue;
    }
    if (operation.type === "duplicate_animations") {
      const animationIds = operationAnimationIds(operation, "duplicate_animations");
      assertSceneAnimationIds(scene, animationIds, "duplicate_animations");
      assertNoAncestorAnimationSelection(scene, animationIds, "duplicate_animations");
      const result = duplicateAnimations(document, scene.id, animationIds);
      document.scenes = result.document.scenes;
      continue;
    }
    if (operation.type === "convert_to_actions") {
      const animationIds = operationAnimationIds(operation, "convert_to_actions");
      assertSceneAnimationIds(scene, animationIds, "convert_to_actions");
      assertNoAncestorAnimationSelection(scene, animationIds, "convert_to_actions");
      const result = convertSceneAnimations(document, scene.id, animationIds);
      document.scenes = result.document.scenes;
      continue;
    }
    if (operation.type === "rename_animation") {
      if (operation.layerId !== undefined && (typeof operation.layerId !== "string" || !operation.layerId))
        throw new Error("rename_animation layerId must be the owner layer ID when provided.");
      if (typeof operation.animationId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(operation.animationId))
        throw new Error("rename_animation needs animationId: a valid animation ID.");
      const name = operationAnimationName(operation.name, "rename_animation");
      const targets = animationOwners(scene).flatMap((owner) => animationTreeEntries(owner.animations)
        .filter(({ animation }) => animation.id === operation.animationId && (!operation.layerId || owner.id === operation.layerId))
        .map(({ animation }) => ({ layerId: owner.id, animationId: animation.id, patch: { name } })));
      if (!targets.length) throw new Error(`Animation ${operation.animationId} was not found${operation.layerId ? ` on layer ${operation.layerId}` : ""}.`);
      const next = editSceneAnimations(document, scene.id, targets, { fonts });
      if (!next) throw new Error(`Animation ${operation.animationId} was not found.`);
      document.scenes = next.scenes;
      continue;
    }
    if (operation.type === "stagger_animations") {
      staggerSceneAnimations(document, scene, operation, fonts);
      continue;
    }
    const layer = scene.layers.find((l) => l.id === operation.layerId);
    if (!layer) throw new Error(`Layer ${operation.layerId} was not found.`);
    // frame_shot {sceneId, layerId, size, samples?}: a hand-placed video layer gets kino's own shot
    // layout (footage/layout.js frameShot): a crop around the face or mark, or a card over a blurred
    // copy of itself. `size` is the file's width and height; `samples` its subjects-v1 samples.
    if (operation.type === "frame_shot") {
      if (isEffectivelyLocked(scene.layers, layer.id)) throw new Error("Unlock this layer before framing it.");
      const taken = new Set(document.scenes.flatMap((item) => item.layers.map((entry) => entry.id)));
      // `marks`: logos burned into the file (footage facts); the crop keeps them out when it can.
      const shot = frameShot(scene, layer, { size: operation.size, samples: operation.samples, taken, ...(Array.isArray(operation.marks) ? { marks: operation.marks } : {}) });
      Object.assign(layer, shot.patch);
      if (shot.backdrop) scene.layers.splice(scene.layers.indexOf(layer), 0, shot.backdrop);
      continue;
    }
    if (operation.type === "style_text_range") {
      if (layer.type !== "text") throw new Error("Select a text layer before styling a range.");
      if (isEffectivelyLocked(scene.layers, layer.id)) throw new Error("Unlock this text layer before styling a range.");
      const substring = Object.hasOwn(operation, "text");
      if (substring && (Object.hasOwn(operation, "start") || Object.hasOwn(operation, "end")))
        throw new Error("Choose offsets or a substring, not both.");
      let { start, end } = operation;
      if (substring) {
        if (typeof operation.text !== "string" || !operation.text || operation.text.length > 65_536)
          throw new Error("Choose a non-empty substring of at most 65,536 characters.");
        start = layer.text.indexOf(operation.text);
        if (start < 0) throw new Error("That substring was not found in this text layer.");
        end = start + operation.text.length;
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start)
        throw new Error("Choose a non-empty text range using integer UTF-16 offsets.");
      const next = withTextStyleRange(layer, start, end, operation.style);
      scene.layers = scene.layers.map((item) => item === layer ? resizeTextLayer(next, fonts) : item);
      continue;
    }
    if (operation.type === "replace_media") {
      const read = (id) => mediaById instanceof Map ? mediaById.get(id) : mediaById?.[id];
      const media = read(operation.mediaId);
      if (!media || media.id !== operation.mediaId) throw new Error("The uploaded media was not found. Import the file first.");
      const replacement = layerWithReplacementMedia(layer, media, {
        previousMedia: read(mediaIdFromSource(layer.src)), sceneDuration: scene.duration,
      });
      assertReplacementKeepsOverrides(document, layer, replacement);
      // A field the replacement leaves out is gone (a still keeps no subject boxes).
      for (const key of Object.keys(layer)) if (!Object.hasOwn(replacement, key)) delete layer[key];
      Object.assign(layer, replacement);
      continue;
    }
    if (operation.type === "convert_to_shape") {
      scene.layers = scene.layers.map((item) => item === layer ? convertLayerToShape(layer) : item);
      continue;
    }
    // outline_text {layerId}: the letters become path layers in a group; the text stays, hidden (outlineText.js).
    if (operation.type === "outline_text") {
      const { group, letters, hidden } = outlineTextLayers(layer, fonts);
      scene.layers = scene.layers.flatMap((item) => item === layer ? [hidden, group, ...letters] : [item]);
      continue;
    }
    if (operation.type === "set_component_overrides") {
      const scenesById = new Map(document.scenes.map((item) => [item.id, item]));
      storeOverrides(layer, componentOverridesWithPatch(layer, scenesById, operation.overrides, { replace: operation.replace ?? false }));
      continue;
    }
    if (operation.type === "reset_component_overrides") {
      storeOverrides(layer, componentOverridesWithout(layer.componentOverrides, resetPaths(layer, operation.componentPaths)));
      continue;
    }
    if (operation.type === "update_layer") {
      validatePathFillRule([layer], operation.properties, "update_layer");
      validateMaskFields([layer], operation.properties, "update_layer");
      const previousAnimations = layer.animations;
      const before = { ...layer };
      // axes merge per axis (fontAxes.js): {axes:{wdth:80}} keeps a set wght, {wdth:null} drops one.
      const properties = operation.properties?.axes ? { ...operation.properties, axes: mergeAxes(layer.axes, operation.properties.axes) } : operation.properties;
      const next = patchTextLayer(layer, boxStylePatch(layer, properties));
      if (!Object.hasOwn(next, "textStyleRanges")) delete layer.textStyleRanges;
      Object.assign(layer, next, {
        id: layer.id,
        type: layer.type,
      });
      // Its presets move with it (presetMove.js), unless this op sets the animations itself.
      if (!Object.hasOwn(operation.properties ?? {}, "animations")) reportMoved(reports, operation, [...carryPresets(before, layer, { document, fonts }), ...carryVolume(before, layer)]);
      const problem = animationListProblem(layer, previousAnimations, scene.duration);
      if (problem) throw new Error(problem);
      // Its cut-outs (cut_out) stay on the same frames of the clip (cutoutTiming.js).
      followClipTiming(scene, before, layer);
      continue;
    }
    if (operation.type === "delete_layer") {
      const deleted = new Set([layer.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const child of scene.layers)
          if (deleted.has(child.parentId) && !deleted.has(child.id)) {
            deleted.add(child.id);
            changed = true;
          }
      }
      const gone = scene.layers.filter((l) => deleted.has(l.id));
      scene.layers = scene.layers.filter((l) => !deleted.has(l.id));
      // A move whose last layer or animation went with them leaves the scene too (its record
      // would still count its techniques in check).
      if (scene.moves?.length) {
        const holds = (l, id) => l.move?.instance === id || animationTreeEntries(l.animations).some(({ animation }) => String(animation.id ?? "").startsWith(`${id}.`));
        scene.moves = scene.moves.filter((entry) => !gone.some((l) => holds(l, entry.id)) || scene.layers.some((l) => holds(l, entry.id)));
      }
      continue;
    }
    if (operation.type === "add_animation") {
      const animation =
        withAnimationDefaults(operation.animation) ||
        presetAnimation(
          operation.effect !== undefined ? `effect:${operation.effect}` : operation.preset || "fade-in",
          layer,
          operation.start || 0,
          scene,
          { mode: operation.mode, parameters: operation.parameters, document, fonts },
        );
      // A caller-chosen id (operation.id) lets later operations in the same call address it.
      const added = { ...animation, id: operation.id || animation.id || uid() };
      if (operation.easing !== undefined) added.easing = operation.easing;
      if (operation.intensity !== undefined) added.intensity = operation.intensity;
      // unit, stagger and order space a text animation's letters, words or lines (smoothing and
      // smoothingIntensity ease that spacing), so a word-by-word reveal is one add_animation.
      const unitFields = ["unit", "stagger", "order", "orderSeed", "smoothing", "smoothingIntensity", "range"].filter((field) => operation[field] !== undefined);
      if (unitFields.length && layer.type !== "text")
        throw new Error(`add_animation ${unitFields.join(", ")} ${unitFields.length === 1 ? "spaces" : "space"} a text layer's letters, words or lines; ${layer.name || layer.id} is a ${layer.type} layer, so leave ${unitFields.length === 1 ? "it" : "them"} out.`);
      for (const field of unitFields) added[field] = operation[field];
      if (operation.motionPath !== undefined) added.motionPath = operation.motionPath;
      if (operation.shadowChannels !== undefined) added.shadowChannels = operation.shadowChannels;
      if (operation.fromCurrent !== undefined) added.fromCurrent = operation.fromCurrent;
      if (operation.textAnchor !== undefined) added.textAnchor = operation.textAnchor;
      if (operation.textClip !== undefined) added.textClip = operation.textClip;
      if (operation.behavior !== undefined) added.behavior = operation.behavior;
      if (operation.duration !== undefined) added.duration = operation.duration;
      if (operation.keepStill !== undefined) added.keepStill = operation.keepStill;
      // fill holds From before the start; peak and return make a value effect rise and fall back.
      for (const field of ["fill", "peak", "return"]) if (operation[field] !== undefined) added[field] = operation[field];
      // On a Resize (width or height) anchor is its own: the point that stays put.
      if (operation.anchor !== undefined && sizeKeys(added).length) {
        if (operation.anchor !== null && !RESIZE_ANCHORS.some((entry) => entry.id === operation.anchor))
          throw new Error(`add_animation anchor on a Resize is the point of the box that stays put: one of ${RESIZE_ANCHORS.map((entry) => entry.id).join(", ")}.`);
        added.anchor = operation.anchor;
      } else if (operation.anchor !== undefined) {
        const pivot = pivotAnchor(operation.anchor, added, layer);
        if (pivot) layer.anchor = pivot;
        else delete layer.anchor;
      }
      if (operation.from !== undefined && added.kind === "effect") added.from = operation.from;
      if (added.kind === "effect" && isRangedEffect(added.effect)) rangedEffectWindow(added, operation, scene);
      if (operation.animation) fillLeftOutFrom(added, layer);
      // Hide and Show are checked against the scene's length below, which names the scene.
      if (operation.animation && !["hide", "show"].includes(added.kind)) {
        const problem = animationProblem(added, layer);
        if (problem) throw new Error(problem);
      }
      // Validate flattened leaves so a newly added Composed group cannot bypass the same Fill,
      // Resize, Hide/Show, Change text, and Counter rules as ordinary animations.
      const nextAnimations = [...layer.animations, added];
      const problem = animationListProblem({ ...layer, animations: nextAnimations }, layer.animations, scene.duration);
      if (problem) throw new Error(problem);
      // A preset entrance that does not fade hides the layer until it starts (entranceHide.js).
      const shown = operation.animation ? null : showBeforeEntrance(layer, added);
      layer.animations = shown ? [...nextAnimations, shown] : nextAnimations;
      continue;
    }
    const animation = animationTreeEntries(layer.animations).find(({ animation: item }) => item.id === operation.animationId)?.animation;
    if (!animation)
      throw new Error(`Animation ${operation.animationId} was not found.`);
    if (operation.type === "update_animation") {
      // `enabled: false` turns the animation off for playback and `true` on (animationEnabled.js).
      const enabledProblem = enabledValueProblem(operation.properties, "update_animation");
      if (enabledProblem) throw new Error(enabledProblem);
      const next = editSceneAnimations(document, scene.id, [{
        layerId: layer.id, animationId: animation.id, patch: operation.properties,
      }], { fonts });
      if (!next) throw new Error(`Animation ${operation.animationId} was not found on layer ${layer.id}.`);
      document.scenes = next.scenes;
      continue;
    }
    if (operation.type === "delete_animation") {
      // A Show added with a preset entrance goes with it (entranceHide.js).
      layer.animations = followEntrance(editAnimationTree(layer.animations, animation.id, () => null), animation, null);
      continue;
    }
    throw new Error(`Unsupported editing operation: ${operation.type}`);
  }
  assertAxesInRange(source, document, fonts);
  // A waiver on a layer lapses when the layer is deleted or its file changes (projectSettings.js).
  if (document.checkWaivers?.length) document.checkWaivers = keptWaivers(source, document);
  // follow and audio behaviors save what they read from their layer (behaviorLinks.js).
  return refreshBehaviorLinks(parseDocument(document), { soundLevels });
}

// add_animation's anchor sets the layer's pivot (geometry.js pivotOf) for a rotate, scale or skew
// (a Resize keeps its own anchor, above):
// [x%, y%] of the box, or one of the nine Resize anchor names. null puts it back at the center.
const PIVOT_KEYS = ["rotation", "scaleX", "scaleY", "skewX", "skewY"];
const sizeKeys = (animation) => [animation.from, animation.to].flatMap((values) => Object.keys(values ?? {})).filter((key) => key === "width" || key === "height");
function pivotAnchor(value, animation, layer) {
  const keys = [animation.from, animation.to].flatMap((values) => Object.keys(values ?? {}));
  if (!keys.some((key) => PIVOT_KEYS.includes(key)))
    throw new Error(`add_animation anchor is the point a rotate or scale turns about; this animation changes ${[...new Set(keys)].join(", ") || "no transform"}. Leave anchor out, or set the layer's anchor with update_layer.`);
  if (value === null) return undefined;
  const named = RESIZE_ANCHORS.find((entry) => entry.id === value);
  if (named) return [named.u * 100, named.v * 100];
  if (!Array.isArray(value) || value.length !== 2 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= 1000))
    throw new Error(`add_animation anchor must be [x, y] in percent of ${layer.name || layer.id}'s box (0 0 top-left, 100 100 bottom-right) or a name like "top-left".`);
  return [...value];
}

// set_component_overrides { sceneId, layerId, overrides, replace? } and
// reset_component_overrides { sceneId, layerId, componentPaths? }: an instance's own changes to
// the layers of its main component (componentOverrides.js). A component path is source layer IDs
// from the main component scene joined with "/" (through nested instances, not groups).
// set merges each entry into the instance's entry for that path (replace: true sets exactly
// `overrides`), and refuses a path that leads to no layer or a property that layer can't override.
// reset removes the listed paths and every deeper path under them; without componentPaths (or
// with null) it resets the whole instance. parseDocument then checks the values and drops the ones
// equal to what the main component already shows.
function storeOverrides(layer, overrides) {
  if (Object.keys(overrides).length) layer.componentOverrides = overrides;
  else delete layer.componentOverrides;
}

function resetPaths(layer, componentPaths) {
  if (layer.type !== "component")
    throw new Error("reset_component_overrides needs layerId: the ID of a component instance.");
  if (componentPaths === undefined || componentPaths === null) return null;
  if (!Array.isArray(componentPaths) || componentPaths.length > MAX_OVERRIDES_PER_INSTANCE)
    throw new Error(`reset_component_overrides componentPaths must be null (reset everything) or an array of at most ${MAX_OVERRIDES_PER_INSTANCE} component paths.`);
  for (const componentPath of componentPaths) {
    const problem = componentPathProblem(componentPath);
    if (problem) throw new Error(`reset_component_overrides: "${String(componentPath)}" is not a component path: it ${problem}.`);
  }
  return componentPaths;
}

// align_layers { sceneId, layerIds, align }: the same alignment as the Design tab buttons.
// `fonts` measures auto-sized text the way the renderer draws it.
function alignSceneLayers(document, scene, { layerIds, align }, fonts) {
  if (!Array.isArray(layerIds) || layerIds.length === 0 || layerIds.length > 5000)
    throw new Error("align_layers needs layerIds: an array of 1 to 5000 layer IDs.");
  for (const id of layerIds) {
    if (typeof id !== "string" || !scene.layers.some((l) => l.id === id))
      throw new Error(`Layer ${String(id)} was not found.`);
  }
  if (!ALIGNMENT_IDS.includes(align))
    throw new Error(`align_layers needs align: one of ${ALIGNMENT_IDS.join(", ")}.`);
  if (!alignmentFrame(scene, layerIds, document.scenes, fonts))
    throw new Error("Audio layers have no position on the canvas to align.");
  for (const move of alignLayers(scene, layerIds, align, document.scenes, fonts))
    Object.assign(scene.layers.find((l) => l.id === move.id), move);
}

// group_layers { sceneId, layerIds, name?, groupId? }: the same grouping as ⌘G in the editor.
// `fonts` measures auto-sized text the way the renderer draws it.
function groupSceneLayers(document, scene, { layerIds, name, groupId }, fonts) {
  if (!Array.isArray(layerIds) || layerIds.length === 0 || layerIds.length > 5000 || layerIds.some((id) => typeof id !== "string"))
    throw new Error("group_layers needs layerIds: an array of 1 to 5000 layer IDs.");
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 256))
    throw new Error("group_layers name must be text of 1 to 256 characters.");
  if (groupId !== undefined && (typeof groupId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(groupId)))
    throw new Error("group_layers groupId must be 1 to 128 letters, digits, or . _ : - characters.");
  scene.layers = groupLayers(document, scene.id, layerIds, { name, id: groupId, fonts }).layers;
}

// create_mask { sceneId, layerIds, maskLayerId?, name?, groupId?, maskInvert?, maskMode? }: the same mask group as ⌃⌘M in
// the editor. The bottom-most layer is the mask unless maskLayerId names another one.
function createSceneMask(document, scene, { layerIds, maskLayerId, name, groupId, maskInvert, maskMode }, fonts) {
  if (!Array.isArray(layerIds) || layerIds.length < 2 || layerIds.length > 5000 || layerIds.some((id) => typeof id !== "string"))
    throw new Error("create_mask needs layerIds: an array of 2 to 5000 layer IDs.");
  if (maskLayerId !== undefined && typeof maskLayerId !== "string")
    throw new Error("create_mask maskLayerId must be the ID of one of the layerIds.");
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 256))
    throw new Error("create_mask name must be text of 1 to 256 characters.");
  if (groupId !== undefined && (typeof groupId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(groupId)))
    throw new Error("create_mask groupId must be 1 to 128 letters, digits, or . _ : - characters.");
  if (maskInvert !== undefined && typeof maskInvert !== "boolean") throw new Error("create_mask maskInvert must be true or false.");
  if (maskMode !== undefined && maskMode !== "luminance" && maskMode !== "alpha") throw new Error('create_mask maskMode must be "luminance" or "alpha".');
  const made = createMask(document, scene.id, layerIds, { maskLayerId, name, id: groupId, fonts });
  // The new mask group carries them (maskVisibility.js maskStyle).
  scene.layers = maskInvert === undefined && maskMode === undefined ? made.layers
    : made.layers.map((layer) => (layer.id === made.groupId ? { ...layer, ...(maskInvert === undefined ? {} : { maskInvert }), ...(maskMode === undefined ? {} : { maskMode }) } : layer));
}

const layerIdList = (layerIds) =>
  Array.isArray(layerIds) && layerIds.length > 0 && layerIds.length <= 5000 && layerIds.every((id) => typeof id === "string");

function operationAnimationIds(operation, type) {
  const ids = operation.animationIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000 || ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(id)))
    throw new Error(`${type} needs animationIds: an array of 1 to 5000 animation IDs.`);
  if (new Set(ids).size !== ids.length) throw new Error(`${type} lists an animation more than once.`);
  return ids;
}

function assertSceneAnimationIds(scene, ids, type) {
  const available = new Set(animationOwners(scene).flatMap((owner) => animationTreeEntries(owner.animations).map(({ animation }) => animation.id)));
  const missing = ids.find((id) => !available.has(id));
  if (missing) throw new Error(`${type} animation ${missing} was not found in scene ${scene.id}.`);
}

function assertNoAncestorAnimationSelection(scene, ids, type) {
  const wanted = new Set(ids);
  const entries = animationOwners(scene).flatMap((owner) => animationTreeEntries(owner.animations));
  const conflict = entries.find(({ animation, parents = [] }) => wanted.has(animation.id) && parents.some((id) => wanted.has(id)));
  if (conflict) throw new Error(`${type} cannot select a Composed group together with one of its members.`);
}

function operationAnimationName(name, type) {
  if (typeof name !== "string" || !name.trim() || name.length > 256)
    throw new Error(`${type} name must be text of 1 to 256 characters.`);
  return name;
}

// maskInvert and maskMode change only a mask layer or a mask group (render.js maskDefinition).
function validateMaskFields(layers, properties, operation) {
  const keys = ["maskInvert", "maskMode"].filter((key) => properties?.[key] != null);
  if (!keys.length) return;
  const masks = (layer) => (properties.isMask ?? layer.isMask) === true || (properties.isMaskGroup ?? layer.isMaskGroup) === true;
  const other = layers.find((layer) => !masks(layer));
  if (other) throw new Error(`${operation} ${keys.join(" and ")} only change a mask layer or a mask group; ${other.name ?? other.id} is neither. Make one with create_mask, then set it on the mask group.`);
}

function validatePathFillRule(layers, properties, operation) {
  if (!properties || !Object.hasOwn(properties, "fillRule")) return;
  if (!Array.isArray(layers) || !layers.length || layers.some((layer) => layer.type !== "path"))
    throw new Error(`${operation} fillRule can only be set on path layers.`);
  if (properties.fillRule !== "nonzero" && properties.fillRule !== "evenodd")
    throw new Error(`${operation} fillRule must be "nonzero" or "evenodd".`);
}

// reorder_layer { sceneId, layerId, to }: the same as ] (front), [ (back), Shift-Command-]
// (forward) and Shift-Command-[ (backward) in the editor, among the layers of its own group.
// A number is the layer's place among them, 0 at the bottom (layerOrder.js reorderLayers).
function reorderSceneLayer(scene, { layerId, to }) {
  if (typeof layerId !== "string") throw new Error("reorder_layer needs layerId: the ID of a layer.");
  if (!ORDER_MOVES.includes(to) && !Number.isInteger(to))
    throw new Error('reorder_layer needs to: "front", "back", "forward", "backward", or a whole number (0 is the bottom of its group).');
  scene.layers = reorderLayers(scene.layers, [layerId], to) ?? scene.layers;
}

// set_layer_flags { sceneId, layerIds, visible?, locked? }: the eye and lock buttons of the
// layer list. A locked or hidden group locks or hides the layers inside it on the canvas.
function setSceneLayerFlags(scene, { layerIds, visible, locked }) {
  if (!layerIdList(layerIds)) throw new Error("set_layer_flags needs layerIds: an array of 1 to 5000 layer IDs.");
  if (visible === undefined && locked === undefined) throw new Error("set_layer_flags needs visible, locked, or both: true or false.");
  for (const [name, value] of [["visible", visible], ["locked", locked]])
    if (value !== undefined && typeof value !== "boolean") throw new Error(`set_layer_flags ${name} must be true or false.`);
  scene.layers = setLayerFlags(scene.layers, layerIds, { visible, locked }) ?? scene.layers;
}

// update_layers { sceneId, layerIds, properties }: the Design tab with several layers selected
// (multiEdit.js). Each listed layer takes the properties it has, a group's new size resizes the
// layers inside it, text boxes refit, and Play settings stay inside each layer's own source.
function updateSceneLayers(document, scene, operation, fonts, reports) {
  const { layerIds, properties } = operation;
  if (!layerIdList(layerIds)) throw new Error("update_layers needs layerIds: an array of 1 to 5000 layer IDs.");
  const layers = layerIds.map((id) => {
    const layer = scene.layers.find((l) => l.id === id);
    if (!layer) throw new Error(`Layer ${id} was not found.`);
    return layer;
  });
  validatePathFillRule(layers, properties, "update_layers");
  validateMaskFields(layers, properties, "update_layers");
  const edit = updateLayersEdit(layers, properties);
  scene.layers = editLayers(scene.layers, layerIds, edit, { scenes: document.scenes, fonts });
  const old = new Map(layers.map((layer) => [layer.id, layer]));
  const moved = scene.layers.filter((layer) => old.has(layer.id)).flatMap((layer) => [...carryPresets(old.get(layer.id), layer, { document, fonts }), ...(Object.hasOwn(properties ?? {}, "animations") ? [] : carryVolume(old.get(layer.id), layer))]);
  reportMoved(reports, operation, moved);
  // Cut-outs of a retimed clip stay on the same frames of it (cutoutTiming.js), as with update_layer.
  for (const layer of scene.layers) if (old.has(layer.id)) followClipTiming(scene, old.get(layer.id), layer);
}

// update_layer and update_layers: a moved or resized layer's presets move with it
// (presetMove.js). Returns [{ layerId, animationId, name }] for each one that moved.
function carryPresets(before, layer, { document, fonts }) {
  const { animations, moved } = movePresetAnimations(before, layer, { document, fonts });
  if (moved.length) layer.animations = animations;
  return moved.map((animation) => ({ layerId: layer.id, animationId: animation.id, name: animation.name }));
}

// update_layer and update_layers: a new volume on a sound layer whose Volume animations go to or
// from its old volume (a fade in to it, a fade out from it, a duck back up to it) scales those
// animations by new / old, so the fades, dips and holds keep their shape at the new level.
// Returns [{ layerId, animationId, name, what }] for each one that changed.
function carryVolume(before, layer) {
  const [was, now] = [Number(before?.volume ?? 1), Number(layer.volume ?? 1)];
  if ((layer.type !== "audio" && layer.type !== "video") || !(was > 0) || !(now >= 0) || Math.abs(was - now) < 1e-6 || !Array.isArray(layer.animations)) return [];
  const volumes = (animation) => ["from", "to"].filter((side) => typeof animation?.[side]?.volume === "number");
  if (!layer.animations.some((animation) => volumes(animation).some((side) => Math.abs(animation[side].volume - was) < 1e-3))) return [];
  const scale = now / was;
  const changed = [];
  layer.animations = layer.animations.map((animation) => {
    const sides = volumes(animation);
    if (!sides.length) return animation;
    const copy = { ...animation };
    for (const side of sides) copy[side] = { ...animation[side], volume: Math.round(Math.min(MAX_VOLUME, animation[side].volume * scale) * 1000) / 1000 };
    changed.push({ layerId: layer.id, animationId: animation.id, name: animation.name, what: "volume" });
    return copy;
  });
  return changed;
}

// The agent's receipt says which presets moved (reports: a Map from operation to report).
function reportMoved(reports, operation, moved) {
  if (moved.length && reports) reports.set(operation, { presetsMoved: moved });
}

// update_animations { sceneId, animationIds, properties }: the Animate tab with several
// animations selected in the Timeline (animationMultiEdit.js). Every listed animation gets the
// same properties, as update_animation would give one. An animation ID is unique in the
// document, so `animationIds` may list plain IDs, or { layerId, animationId } pairs that also
// say which layer the animation must be on. `patch` is accepted in place of `properties`.
// The usual checks run for each animation, and the whole call is refused when one fails.
function updateSceneAnimations(scene, operation, context) {
  const { animationIds } = operation;
  if (!Array.isArray(animationIds) || animationIds.length === 0 || animationIds.length > 5000)
    throw new Error("update_animations needs animationIds: an array of 1 to 5000 animation IDs or { layerId, animationId } pairs.");
  if (operation.properties !== undefined && operation.patch !== undefined)
    throw new Error("update_animations takes properties or patch, not both.");
  const properties = operation.properties ?? operation.patch;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || Object.keys(properties).length === 0)
    throw new Error("update_animations needs properties: an object with the animation properties to change, such as { \"start\": 1 }.");
  if (Object.hasOwn(properties, "id")) throw new Error("update_animations can't change an animation's id.");
  const enabledProblem = enabledValueProblem(properties, "update_animations");
  if (enabledProblem) throw new Error(enabledProblem);
  const owners = new Map();
  for (const layer of scene.layers)
    for (const { animation, parents = [] } of animationTreeEntries(layer.animations)) owners.set(animation.id, { layer, animation, parents });
  const targets = animationIds.map((item) => {
    const pair = item && typeof item === "object" && !Array.isArray(item);
    const id = pair ? item.animationId : item;
    if (typeof id !== "string" || (pair && typeof item.layerId !== "string"))
      throw new Error("update_animations animationIds entries must be animation IDs or { layerId, animationId } pairs of strings.");
    const found = owners.get(id);
    if (!found || (pair && found.layer.id !== item.layerId))
      throw new Error(pair ? `Animation ${id} was not found on layer ${item.layerId}.` : `Animation ${id} was not found.`);
    return found;
  });
  if (new Set(targets.map((target) => target.animation.id)).size !== targets.length)
    throw new Error("update_animations lists an animation more than once.");
  const selected = new Set(targets.map(({ animation }) => animation.id));
  if (targets.some(({ parents }) => parents.some((id) => selected.has(id))))
    throw new Error("update_animations cannot edit a Composed group and one of its members together.");
  const next = editSceneAnimations(context.document, scene.id, targets.map(({ layer, animation }) => ({
    layerId: layer.id, animationId: animation.id, patch: structuredClone(properties),
  })), { fonts: context.fonts });
  if (!next) throw new Error("update_animations did not find any selected animations.");
  context.document.scenes = next.scenes;
}

// stagger_animations { sceneId, items, delay, order?, seed? }: the Timeline's Stagger command
// (stagger.js). `items` lists animations (IDs or { layerId, animationId } pairs) and layers
// ({ layerId }: the layer's animations, and those of the layers inside it, move as one block);
// their starts become `delay` seconds apart in `order` ("timeline" when left out). Durations
// stay the same, and the call is refused when the last item (counting a text animation's last
// letter, word or line, measured with `fonts`) would end after the scene's end.
function staggerSceneAnimations(document, scene, { items, delay, order = "timeline", seed }, fonts) {
  if (seed !== undefined && order !== "random")
    throw new Error('stagger_animations seed is only used with order "random".');
  const entries = operationStaggerItems(scene.layers, items, fonts);
  const animationIds = entries.flatMap((item) => item.parts.map((part) => part.animationId));
  assertNoAncestorAnimationSelection(scene, animationIds, "stagger_animations");
  const plan = staggerPlan(entries, {
    delay,
    order,
    seed: seed ?? 1,
    sceneDuration: scene.duration,
  });
  if (plan.problem) throw new Error(plan.problem);
  if (!plan.changes.length) return;
  const next = editSceneAnimations(document, scene.id, plan.changes, { fonts });
  if (next) document.scenes = next.scenes;
}

// move_layers { sceneId, layerIds, position, referenceId? , parentId? }: dragging rows in the
// layer list. position "above" or "below" puts the layers next to referenceId, in its group;
// "top" or "bottom" puts them at the top or bottom of the group parentId (null or left out:
// the scene's top level). Layers keep their look on the canvas when they change group.
// mask: true lets a mask that had nothing to mask start masking a moved layer (refused
// without it, so a move never masks by accident).
function moveSceneLayers(document, scene, { layerIds, position, referenceId, parentId, mask }, fonts) {
  if (!layerIdList(layerIds)) throw new Error("move_layers needs layerIds: an array of 1 to 5000 layer IDs.");
  if (mask !== undefined && typeof mask !== "boolean") throw new Error("move_layers mask must be true or false.");
  if (position === "above" || position === "below") {
    if (typeof referenceId !== "string") throw new Error(`move_layers with position "${position}" needs referenceId: the layer to move next to.`);
    const moved = moveLayers(document, scene.id, layerIds, { side: position, referenceId }, { fonts, mask });
    if (moved) scene.layers = moved.layers;
    return;
  }
  if (position !== "top" && position !== "bottom")
    throw new Error('move_layers needs position: "above" or "below" (with referenceId), or "top" or "bottom" (with parentId, or none for the top level).');
  if (parentId !== undefined && parentId !== null && typeof parentId !== "string")
    throw new Error("move_layers parentId must be the ID of a group, or null for the scene's top level.");
  const moved = moveLayers(document, scene.id, layerIds, { side: position, parentId: parentId ?? null }, { fonts, mask });
  if (moved) scene.layers = moved.layers;
}

// A ranged effect (RGB Shift, Fluid Warp, ...) added without a time covers the whole scene and
// holds both ends (keepStill "both"). Given a start or a duration, it runs in that window only:
// the start is kept (the preset factory starts ranged effects at 0), it lasts to the scene end
// unless a duration is given, and keepStill is "off" unless the caller chose one.
function rangedEffectWindow(added, operation, scene) {
  const full = operation.animation;
  if (!full && operation.start !== undefined) {
    added.start = Math.min(operation.start, Math.max(0, scene.duration - 0.001));
    if (operation.duration === undefined) added.duration = Math.max(0.001, scene.duration - added.start);
  }
  const windowed = Boolean(full) || operation.start !== undefined || operation.duration !== undefined;
  const keepStillChosen = operation.keepStill !== undefined || full?.keepStill !== undefined;
  if (windowed && !keepStillChosen) added.keepStill = "off";
}

// An unknown effect key is left for the document check, which names the known keys.
function isRangedEffect(key) {
  try { return effectDefinition(key).kind === "ranged"; } catch { return false; }
}

// A value an animation's `to` names but its `from` leaves out starts where the layer is drawn
// at the animation's start: where an earlier animation of that value left it, else the layer's
// own value. It is sampled once, the way fromCurrent samples it, and saved in `from`. Before, it
// was always the layer's own value, so a second move ({to:{x:800}} at 2 s, after a move from
// x 100 to 1600) jumped back to x 100 first.
function fillLeftOutFrom(animation, layer) {
  if (!["custom", "in", "out"].includes(animation.kind) || animation.fromCurrent || animation.preset) return;
  const from = animation.from && typeof animation.from === "object" && !Array.isArray(animation.from) ? animation.from : {};
  const to = animation.to && typeof animation.to === "object" && !Array.isArray(animation.to) ? animation.to : {};
  const missing = Object.keys(to).filter((key) => !Object.hasOwn(from, key));
  if (!missing.length || !layer.animations?.length) return;
  const sample = (animations) => {
    const probe = { ...animation, kind: "custom", fromCurrent: true, from: {} };
    delete probe.preset;
    try {
      return resolveAnimationInitialValue({ ...layer, animations: [...animations, probe] }, probe).from ?? {};
    } catch {
      return {};
    }
  };
  const drawn = sample(layer.animations);
  const own = sample([]);
  const filled = missing.filter((key) => drawn[key] !== undefined && JSON.stringify(drawn[key]) !== JSON.stringify(own[key]));
  if (filled.length) animation.from = { ...from, ...Object.fromEntries(filled.map((key) => [key, structuredClone(drawn[key])])) };
}

// A full animation object may leave out its name and, for timed kinds, its easing. The name
// defaults to the effect's label ("Wiggle") or the kind ("Custom"). The easing matches the presets:
// "smooth" (0.5, 0, 0, 1), the usual default curve, for every kind, and
// "linear" for an in or out that only fades. Effects already default
// their easing to the effect's own.
const onlyFades = (animation) => {
  const keys = [...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})];
  return keys.length > 0 && keys.every((key) => key === "opacity");
};
function defaultEasing(animation) {
  if ((animation.kind === "in" || animation.kind === "out") && onlyFades(animation)) return "linear";
  return "smooth";
}
const KIND_NAMES = { in: "In", out: "Out", custom: "Custom", counter: "Counter", hide: "Hide", show: "Show", "change-text": "Change text", composed: "Group" };
function withAnimationDefaults(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const animation = { ...raw };
  if (animation.name === undefined) {
    animation.name = animation.kind === "effect"
      ? (() => { try { return effectDefinition(animation.effect).label; } catch { return "Effect"; } })()
      : KIND_NAMES[animation.kind] ?? "Animation";
  }
  if (animation.easing === undefined && ["in", "out", "custom", "counter"].includes(animation.kind)) animation.easing = defaultEasing(animation);
  if (Array.isArray(animation.animations)) animation.animations = animation.animations.map(withAnimationDefaults);
  return animation;
}
