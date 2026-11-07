---
name: kino
description: Makes and edits motion videos with kino, a local motion design engine (product promos, ads, social clips, explainers, logo stings, animated text, captions, music cut to the beat) and renders them to MP4, GIF, PNG or Lottie. Use when asked to make, change, check or render a video, animation or motion graphic, or when kino's tools or the `kino` command are available.
---

# kino

## The short path

Every kino answer ends with `next:`, the most likely next call written out. When unsure,
send it as it is; put your own words where it has `<angle brackets>`. A new video, idea first:

1. `project {action:"create", id:"orbit", name:"Orbit promo", width:1920, height:1080, duration:15}`
2. `notes` brief: what the person asked for, one line each (plain text is your guess).
3. Save 2 references (`library {topic:"inspire"}`), study one (`look {mode:"reference"}`).
4. 5 treatments, their pick, its signature (`style.signatures`); building first is refused (`order_needed`).
5. `edit` with one `compose` (or `format`: `library {topic:"formats"}`), then `check {fix:"auto"}` and `look {mode:"review"}`; then `render`.

```json
{"tool":"notes","action":"brief","fields":{"message":"Plan the whole week in one view","plays_on":"web, 16:9","made_from":"kino blocks","look_sound":"dark, bold type","never":"no stock photos"},"no_playback":"just start"}
{"tool":"edit","ops":[{"op":"compose","duration":6,"beats":[{"recipe":"logo-sting","text":"Orbit","tagline":"Plan the week in one view"}]}],"expect":"order_needed"}
{"tool":"check","fix":"auto"}
{"tool":"look","mode":"review"}
```

## Tools

`mcp__kino__<verb>` (plugin: `mcp__plugin_kino_kino__<verb>`); the CLI takes the same
fields as `key=value`: `kino look frame t=3` (`kino help`).

| Tool | Use |
|---|---|
| `status` | The outline, `direction:`, `step:`, the plan and your inbox. Call it first. |
| `edit {ops}` | Every change: a list of `{op, …}`, saved as one revision with a receipt. |
| `check` | Findings with fix ops; `{fix:"auto"}` fixes and re-checks in one call. |
| `look` | `sheet`, `review`, `changed`, `frame`, `frames`, `motion`, `zoom`, `board`, `versus`, `viewer`, `critique`. |
| `inspect {targets}` | Exact layer, animation, cue fields. |
| `render` | Files: `{action:"start", quality:"final", out:"<absolute folder>", wait:true}`. |
| `library` | Exact rules: `{topic:"op", name}` (fields, an example), presets, fonts, blocks. |
| `history` | Your turns; `{action:"revert", turn:"T3"}` undoes one. |
| `notes` | The `brief`, stops, plan, the person's notes, `helper` agents. |
| `project` | `create`, `open`, `import`, `share`, `manage` the workspace. |

## The loop

1. `status`; inbox notes first (`notes reply` when fixed; `always ▸` ones stay). New chat or compaction: first say its `direction:` back in one sentence, and trust it over your memory.
2. New video: the brief from the chat and, with footage, the storyboard before you build
   (direction reference). Save their material (`edit` op `source`) and write the story.
   **A video is one scene**: `render` makes one file per scene.
3. Save 2+ edits like yours (`library {topic:"inspire", search}`), study their
   strips; then `notes {action:"set_plan", steps:[…]}`, 3–6 steps (`{done:[n]}` ticks).
4. First a rough whole scene in **one** `edit` (`compose`).
   Then up to 3 sections, each an `edit` + `look {from, to}`.
5. Read the receipt, not `status`.
6. A receipt's `newFindings` are what that edit broke: fix them; `check` before a render or "done".
7. One `look` per pass or section. All fixes in one `edit`, then `look {mode:"changed"}`.
8. Before a final render: `look {mode:"review"}` until every moment is reviewed; fix.
9. Ask each stop `step:` names (`notes {action:"checkpoint", id:"rough"}`): final waits.
10. Final (5 s+) needs a saved reference and a recent `look {mode:"versus"}`;
    `notes {action:"judge"}`: the person picks blind. Fix where they win.
11. Final (15 s+, footage or speech): `notes intents`, a fresh subagent watches
    `look {mode:"viewer"}`; `notes viewer`; fix story bugs ([viewer](references/viewer.md)).
12. 10 s+: a fresh critic reads `look {mode:"critique"}`; `notes critique`; fix P0s, UPs; `notes verdict`: the bar ([critique](references/critique.md)).
13. Material short? Ask ([needs](references/needs.md)).

## Rules

- Name things: `name` on `add_layer` is its ID, so later ops (same edit too) say
  `layer:"headline"`; `headline.in` is its entrance once saved. Codes (`L3`, `A2`, `s1`) work too.
- One scene: no `scene` field. Several: `scene:"s2"` or its name.
- Positions: top-left, scene pixels; colors hex. Text needs a `width` and `height` that fit.
- Restraint: plain cuts; 1-2 signature moves; one type style, grade, brightness.
- `add_layer` takes its animations inline: `animations:[{preset:"preset-fade", start, duration}]`;
  `"mode":"out"` makes an exit.
- A refused edit saves nothing; `next` resends it fixed, or send fixes:
  `edit {retry:"E2", fix:{"3":{"easing":"smooth"}, "7":null}}`.
- `{status:"awaiting_approval", id:"Q1"}`: tell them; a chat yes counts (notes answer).
  `{held:true}`: nothing changed; wait for "hold released" (inbox).
- `{status:"waiting_for_you", id:"C1"}` (a stop): send its `ask`, end your turn, record their
  reply with `notes answer`. Until then writes answer `{waiting}`.

## References

- [edits](references/edits.md): ops, refusals, presets, easing.
- [fields](references/fields.md): every op's fields.
- [building-blocks](references/building-blocks.md): compose, recipes, brand, formats; [moves](references/moves.md).
- [captions-beats-sequences](references/captions-beats-sequences.md): captions, beats, cues, text range.
- [media](references/media.md): imports, cuts, speed, syncing, B-roll; [recording](references/recording.md).
- [framing](references/framing.md): 9:16 crops; [screens](references/screens.md): UI shots; [tilt](references/tilt.md): 3D; [behaviors](references/behaviors.md).
- [storyboard](references/storyboard.md): `look board`.
- [sound](references/sound.md): ducking, voice; [library](references/sound-library.md): SFX, music.
- [color](references/color.md): grading, filters; [cutout](references/cutout.md): subject cut-outs, track, pin.
- [blur](references/blur.md), [light](references/light.md), [particles](references/particles.md): glow, sparks, fog.
- [check-and-look](references/check-and-look.md): findings, looks, review; [motion](references/motion.md).
- [ideas](references/ideas.md): story.
- [techniques](references/techniques.md): the style spec; [spine](references/spine.md): idea and lock.
- [taste](references/taste.md): motion, readability, restraint.
- [direction](references/direction.md): the brief, the stops, playback.
- [dashboard](references/dashboard.md): history, notes, helpers.
- [render](references/render.md): formats, encoders.
- [inspire](references/inspire.md): edits' cuts, [songs, no music](references/soundtrack.md); [workspace](references/workspace.md): copying, imports.
