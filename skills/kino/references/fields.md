# Edit op fields

Every `edit` op on one line: `?` marks a field you may leave out, `|` a choice. One scene needs
no `scene`. `library {topic:"op", name}` gives an op's full rules and an example that works.
Made by `npm run skill:fields` from the agent service; do not edit by hand.

Contents: Building blocks · Layers · Layout · Text · Animations · Scenes · Components · Media, sound, captions and cues · Project, copies and data · Other

## Building blocks

- `compose {footage:[media or {media, in?, out?}], music?, voice?, treatment?: calm|story|punchy|loud, pace?: promo|velocity, accents?, cards?, cardGap?, lines?, duration?, format?, seed?, title?, end?} or {format?, duration?, look?, brand?, feel?, type?: promo|ad|clip|explainer|sting|other, seed?, fps?, reduced?, beats:[{recipe, copy or its fields, media?, dur?, slot?, transition?, id?, seed?, hero?, region?}], scene?, id?, name?}`
- `recipe {name, scene?, id?, at?, dur?, slot?, copy or its fields (text, sub, …), media?, look?, brand?, feel?, seed?, align?, enter?, uppercase?, hero?, box?, color?, corner?, role?, reduced?}`
- `move {name, at, align?, dur?, scene?, id?, seed?, reduced?, look?, brand?, …its fields}`
- `set_brand {name, colors?: {bg, surface, text, accent, accent2}, fonts?: [{family, weight?}] (headlines, then body), logos?: [{media}|{text}], motion?: snappy|smooth|calm}`
- `remove_brand {name}`
- `set_cue {name, at | layer, media}`
- `remove_cue {name}`
- `variants {scene, vary?:"layout"|"timing"|"look"|"deck"|"format", count?, formats?}`
- `pick_variant {scene}`
- `make_template {scene, intro?, outro?, fields?: [{name, layer, property}]}`
- `use_template {template, id?, name?, values?: {field: value}, duration?}`

## Layers

- `add_layer {scene?, layerType, properties, animations?}`
- `update_layer {scene?, layer, properties}`
- `update_layers {scene?, layers, properties}`
- `delete_layer {scene?, layer}`
- `duplicate_layers {layers, offset?:24, count?:1..50, layout?:line|grid|radial, spacing?:{x,y}, columns?, radius?, stagger?:s}`
- `convert_to_shape {scene?, layer}`
- `outline_text {scene?, layer}`
- `group_layers {scene?, layers, name?, groupId?}`
- `ungroup_layer {scene?, layer}`
- `create_mask {scene?, layers, maskLayerId?, name?, groupId?, maskInvert?, maskMode?}`
- `remove_mask {scene?, layer}`
- `reorder_layer {scene?, layer, to}`
- `move_layers {scene?, layers, position, referenceId? | parent?, mask?}`
- `set_layer_flags {scene?, layers, visible?, locked?}`
- `multi_transform {layers, action:{kind:"move",dx,dy}|{kind:"scale",scaleX,scaleY,anchor?,keepAspect?}|{kind:"rotate",degrees}}`
- `import_svg {svg,name?,x?,y?}`

## Layout

- `place {layers, below|above|left_of|right_of: <layer>, gap?, align?: start|center|end}`
- `align {layers, to: left|center|right|top|middle|bottom (or a list of two), within?: safe|frame|<slot>|<layer>}`
- `distribute {layers, axis?: x|y, within?}`
- `stack {layers, direction?: down|right, gap?, slot?, align?: start|center|end}`
- `fit {layers, into?: safe|frame|<slot>|<layer>}`
- `align_layers {scene?, layers, align}`

## Text

- `set_font {layers, family, weight?, style?}`
- `style_text_range {scene?, layer, start?, end? | text?, style}`
- `apply_text_effect {name,layers,time?:0}`

## Animations

- `add_animation {scene?, layer, preset, start?, mode?, parameters?, duration?, easing?, intensity?, unit?, stagger?, anchor?, ...} or {scene?, layer, animation} or {scene?, layer, keys}`
- `update_animation {scene?, layer, animation, properties}`
- `update_animations {scene?, animationIds, properties}`
- `delete_animation {scene?, layer, animation}`
- `rename_animation {scene?, animation, name, layer?}`
- `stagger_animations {scene?, items, delay, order?, seed?}`
- `group_animations {scene?, animationIds, name?}`
- `ungroup_animations {scene?, animationIds}`
- `duplicate_animations {scene?, animationIds}`
- `convert_to_actions {scene?, animationIds}`
- `copy_animations {fromProject?,fromScene?,sourceAnimations,layers,time?:0}`
- `apply_easing {name,animationIds}`

## Scenes

- `add_scene {properties: {id?, name, width, height, duration, background, layers?, ...}}`
- `update_scene {scene?, properties}`
- `duplicate_scene {scene}`
- `delete_scene {scene}`
- `retime {scene, duration}`
- `add_sequence {properties: {id?, name}, scenes, transition?, transitions?, background?}`

## Components

- `create_component {scene}`
- `create_component_from_layers {scene?, layers, name?, component?, instanceId?}`
- `insert_component {scene?, component, properties?}`
- `detach_component {scene?, layer}`
- `set_component_overrides {scene?, layer, overrides, replace?}`
- `reset_component_overrides {scene?, layer, componentPaths?}`

## Media, sound, captions and cues

- `replace_media {scene?, layer, mediaId}`
- `sync_clips {scene?, layer, to, search? | at?}`
- `duck_audio {scene?, layer, under, to?, fade?, fadeUp?}`
- `isolate_voice {scene?, layer, keep?, engine?, amount?}`
- `cut_out {scene?, layer, output?, engine?, grow?, feather?, color?, invert?, points?, exclude?, time?, above?, behind?, name?, refine?, fillHoles?, openEdges?, edge?, width?, step?, detail?}`
- `add_captions {scene?, text | file | words | speech, fix?, offset? | layer?, timing?, name?, start?, end?, fontSize?, fontFamily?, fontWeight?, fill?, box?, position?, appear?, look?, accent?, keywords?, hook?, reduced?}`
- `detect_beats {scene?, layer, onsets?, rhythm?}`
- `set_cues {cues?, replace?, remove?}`

## Project, copies and data

- `rename_project {name}`
- `update_project {properties: {name?, videoType?, rhythm?, fps?, shutterAngle?}}`
- `waive_check {code, target, reason}`
- `unwaive_check {code, target}`
- `copy_layers {fromProject?,fromScene?,layers,scene?,replaceLayers?}`
- `copy_scene {fromProject?,fromScene,scene?,replace?:false}`
- `bulk_create {scene, csv or rows, deleteMissing?:false}`

## Other

- `cut_speech {scene?, layer, words? | spans?, pauses?, restore?, ripple?, morph?}`
- `fit_music {scene?, layer, payoff?, turn?, end?, plan?, drop?, recut?}`
- `place_broll {scene?, speech, clips, lead?}`
- `color_filter {scene?, layer | layers, filter, strength?}`
- `keep_line {scene?, layer, line? | from?, to?, text?, subtitle?, look?, name?, duck?, dip?, dropout?}`
- `frame_shot {layer | layers}`
- `match_color {scene?, layer | layers, to, at?}`
- `track {scene?, layer, at, point | box, name?}`
- `pin {scene?, layer, to, offset?, scale?}`
- `stabilize {scene?, layer, smooth?, zoom?}`
- `format {name, slots:{…}, aspect?, scene?, id?, seed?}`
- `frame {layer, rect:[x, y, w, h], at, to?, cut?, dur?}`
- `shift {at, by, scene?}`
- `mark_subject {layer, t, box, part?, shows?}`
- `match_references {scene?, layer? | layers?, remove?, lower?}`
- `split_image {layer, boxes:[{name, rect:[x, y, w, h]}]}`
- `source {name, text}`
- `board {music, shots:[{cue, dur, pacing, media, in, crop, subject, follow, text, sound, move, why, speed?, alts?, id?}], calls?, open?}`
- `split_layer {layer, at} or {layer, from, to}`
- `trace_image {layer|media, time?, region?, colors?:4, smooth?:1, minArea?:16, background?, as?, name?}`
