# kino plan

kino is a motion design engine that coding agents drive. An agent such as Claude Code or Codex
makes the video through ten kino tools (or the `kino` command line). The kino window is a
dashboard that shows what the agent does; people change settings, approve, hold, undo and leave
notes there, but do not edit by hand.

**Status (2026-10-26):** milestones A0 to A7, the direction milestones B1 to B4b and LIVE are
built (§8). A8 is not planned. The decisions are at the end. The evidence for every feature is
in [COMPATIBILITY.md](../COMPATIBILITY.md); this file says what kino is meant to be and what is
left.

**History.** This plan was draft 2, approved on 2026-10-17. It replaced draft 1
(a redesigned manual editor), deleted on 2026-10-26: `git show bbc961d:docs/redesign-plan.md`.
Its feature checklist became the reachability audit (§7.2), and its engine work that is not built is in §8.
The section numbers below are kept because code comments cite them (for example `plan §5.8`).
"Direction plan" in code comments means a separate plan for B1 to B4b that is kept private.

## 1) Goals

- **Agents do the editing.** Few tools, small answers, checked operations.
- **Better videos by default.** Taste lives in the data (named tokens, slots, roles, recipes,
  looks) and in checks that block a final render, not in advice an agent may skip. Motion is
  judged from timeline numbers, not by an image model.
- **People stay in control** without editing: settings, approvals, notes, hold, undo a turn.
- **The hard rules** (AGENTS.md): no account, local and private, no fake success, browser and Mac
  app keep the same renderer, documents and API, accessibility and reduced motion included.

## 2) How it works

1. You ask your agent for a video in its own terminal.
2. The agent loads the kino skill and calls kino tools (MCP or the `kino` CLI). Both call
   `POST /api/agent/<verb>` on the running server (`backend/agent/service.mjs`).
3. The server applies the changes, checks them, renders frames and answers with short receipts.
4. Every call and every image the agent gets also goes to the dashboard as a live event.
5. Your notes, approvals and undos reach the agent in its next tool answer (the inbox).

## 3) The agent interface

### 3.1 Principles

1. Few tools, shaped around intent (one per job, not one per action).
2. Short tool descriptions (at most 1,000 characters each); details on demand through `library`.
3. Read in layers: a short outline first, full details only for what the agent asks about.
4. Answer edits with what changed, never the whole document.
5. Say what you want; the server works out the numbers (recipes, relative timing, slots).
6. Check with numbers first, cheap images second, full frames only on request.
7. The same verbs over MCP and on the command line.
8. Never change the tool list during a session (it breaks the agent's prompt cache).
9. Local, no account, never read another app's tokens.

### 3.2 The 10 tools

`status`, `edit`, `check`, `look`, `inspect`, `render`, `library`, `history`, `notes`, `project`.
What each does: [connect-an-agent.md](connect-an-agent.md).

- **Budget, enforced by `npm run mcp:budget`:** the ten tool definitions stay at or under 5,800
  estimated tokens (`TOOL_LIST_TOKEN_BUDGET` in `backend/agent/tools.mjs`; JSON counted at 2.1
  characters a token, `backend/meter.mjs`); the server instructions stay under 4,096 characters;
  no answer is over 8,000 tokens (a longer one is saved to `<data>/agent/out/<project>/` and the
  agent gets its first 3 lines and the path).
- **Small input schemas.** The `edit` schema lists op names and shared fields; the server checks
  each op in full, and a refused op's error carries that op's rules.
- `status`, `edit`, `check` and `look` are loaded up front in Claude Code (`anthropic/alwaysLoad`).
- **Not done on purpose:** `outputSchema`/`structuredContent` (it would send the same facts twice;
  the CLI's `--json` has them), and `requiresUserInteraction` on archive (archive only moves a
  project to Trash).
- **Later, optional: `run`**, a short program against a typed kino API for bulk work. Only with a
  real sandbox (D7).

### 3.3 Reading: the outline

`status` returns one line per scene and per layer. Rules for every read: leave out default
values; round numbers (whole pixels, 2-decimal times, hex colors); use names the agent chose
plus short codes (`s1`, `L7`, `A12`, or `cta.in`), never random IDs; collapse what is out of
focus to counts; mark unchanged parts as unchanged.

### 3.4 Writing: operations, timing and placement

- **One `edit` call** applies up to 200 ops; all apply or none do; `dry_run` checks without
  saving. The receipt gives the new revision, created and changed codes, animation times and
  check counts.
- **Relative timing:** `at` takes seconds, `after:<animation>`, `with:<animation>+0.1`,
  `cue:<name>`, or `auto`. The server converts to seconds and returns the result.
- **Placement:** a 6×6 slot grid over the safe area (`C2:E3`), plus `place`, `align`,
  `distribute`, `stack` and `fit`. Slots are relative, so one scene adapts to 16:9, 9:16 and 1:1.
  Raw pixels are allowed but never the default.
- **Named values:** durations (`micro`, `standard`, `emphasis`, `hero`), easings (`enter`,
  `exit`, `move`, `hero`), type sizes, color roles (`bg`, `surface`, `text`, `accent`, `accent2`).
- **Roles:** `hero`, `support`, `decoration`, `body`, `logo`, `cta`, `caption`. They set default
  motion strength and stagger order and drive several checks.
- **Recipes and `compose`:** one op expands on the server into tuned layers and keyframes, with
  its own motion assertions (§4.3). `compose` builds a whole scene from beats. `variants` makes
  2 to 6 sibling scenes to pick from.
- **Escape hatch:** every lower-level op (layers, masks, components, motion paths, raw keyframes)
  still works and goes through the same checks.

### 3.5 Errors

Nothing is saved when any op fails. The error gives the failing op's number, the reason, a "did
you mean" for misspelled names, that op's rules, and whether a retry is safe. A misspelled name
is fixed only when exactly one name matches, and the fix is reported. A conflict answers with
the current revision and the changed IDs, after an automatic replay on the newer revision.

### 3.6 Seeing: `look`

Modes: `frame`, `sheet`, `zoom`, `strip`, `compare`, `changed`, `source`, `board` (details in
[connect-an-agent.md](connect-an-agent.md)). Every image comes from the export renderer, so the
agent sees the pixels the video will have. Frames are cached by content. `look` returns the image
inline plus its file path; every other tool returns paths only.

### 3.7 Rendering: the render ladder

Validate (every `edit`) → stills and sheets (`look`) → draft (half size, 15 fps) → final (full
size, motion blur, dithering). `render` starts a background job and answers at once; the agent
calls `render wait`. A final render is refused while a gate fails (unless waived with a reason)
and while a stop is open (§5.7). After a render kino reads the file back and compares it with
the renderer's own frames: length, unexpected black, frozen or flickering frames
(`backend/render-output-audit.mjs`).

### 3.8 Skill, plugin and setup

- `skills/kino/SKILL.md` is short (under 7,000 characters, checked by `backend/skill.test.mjs`);
  details are in `skills/kino/references/`, read only when needed.
- Claude Code installs kino as a plugin (`.claude-plugin/`); Codex finds the skill at
  `.agents/skills/kino`; other agents read the same text with `library {topic:"guide"}`.
- `kino setup` finds installed agents, lists every change and asks first. It never reads an
  app's login or token files.

## 4) Quality

### 4.1 Where weak videos come from

Text that leaves before you can read it; everything moving the same way at the same speed; poor
pacing; generic looks (glowing headline, gradient blob, pill buttons, neon on dark); tiny type;
crowded scenes; motion that ignores the music.

### 4.2 Strategy

1. Taste lives in the data: named tokens, roles, slots, recipes and looks.
2. Gates, not advice: an error-level finding blocks the final render.
3. Motion is judged from numbers: kino samples every layer's position, scale, rotation and
   opacity over time. Image models judge motion poorly.
4. Images are for composition only; an image model's opinion never decides pass or fail.

### 4.3 Gates: errors that block the final render

| Check | Rule | Source |
|---|---|---|
| `linear_motion` | No linear easing on position, scale or rotation, except layers marked `perpetual`. | Motion design guidelines |
| `reading_time` | Each text is fully readable for at least max(characters ÷ 20 per second, 20 frames). | Subtitle reading-speed guidelines |
| `type_min` | Readability floor: body 3%, a text marked role headline 4% of the frame's short side (32 and 43 px at 1080p). | Caption and phone-reading guidelines |
| `overlap` | No unintended overlap or clipping of text or logos at any checked time. | Layout checks |
| `safe_zone` | Text, logo and CTA stay inside the platform's safe zone. | EBU R95; measured Reels/TikTok zones |
| `contrast` | ≥4.5:1 (≥3:1 for large text), measured on the real pixels behind the text. | WCAG 1.4.3 |
| `flashing` | At most 3 flashes a second over more than about 2.8% of the frame. | WCAG 2.3.1 |
| `av_offset` | Audio and video within 45 ms early to 125 ms late. | ITU-R BT.1359 |
| `assertions` | A scene's promises hold (`visible_by`, `before`, `inside_frame`). | Motion verification research |
| `spring_on_fade` | No bounce or overshoot on opacity or color. | Motion design guidelines |
| `same_motion` | In a scene with 4 or more animated layers, not all share one easing and duration. | Motion design guidelines |
| `promo_basics` | Promos and ads: brand by 5 s, message by 5 s, hero ≥30% of the frame once, a CTA in the last 20%. | Ad effectiveness guidelines |

Each finding has `measured`, `required` and a fix. A problem that lasts 2 samples or less is
info only. `waive_check` records a deliberate exception with a reason, shown on the dashboard.

### 4.4 Warnings (shown, do not block)

Shorter than the recommended hold; durations outside their band; exits not 55 to 75% of their
entrance; stagger groups over 0.5 s or out of role order; repeated easings; more than one bouncy
layer; scenes all the same length; everything centered; generic looks (gradient text, neon on
dark, pure black or white frames, default fonts the brand does not name); speed jumps, banding
and judder; static scenes; accents off the beat. The current list (26 gates and 78 warnings in
`engine/quality/` on 2026-10-30) is printed by `library {topic:"rules", name:"quality"}`.

### 4.5 The building blocks

- **Motion tokens:** `micro` 0.15–0.3 s, `standard` 0.3–0.5 s, `emphasis` 0.5–0.8 s, `hero`
  0.8–2.0 s. Easings (cubic-bezier): `enter` 0.05, 0.7, 0.1, 1; `exit` 0.3, 0, 0.8, 0.15; `move`
  0.2, 0, 0, 1; `hero` 0.4, 0.14, 0.3, 1. Springs only on position, scale and rotation.
- **Looks:** `crisp`, `editorial`, `bold`, `calm`, `data`. Each sets a type scale, color roles,
  motion feel and background.
- **Recipes:** 24 recipes and 3 transitions (`engine/blocks/recipes/`) for promos, vertical clips,
  explainers and logo or kinetic type. Each passes every gate at 5 seeds and 3 formats.
- **Brand kits:** colors mapped to roles, up to 2 font families, logos.
- **Templates with protected timing:** intro and outro keep their timing; the middle stretches.

### 4.6 Choices where sources disagreed

- Reading holds win over "keep moving": no keep-moving rule, only a static-scene warning.
- Bounce and elastic: position, scale and rotation only, at most one layer a scene.
- Exit length: 55 to 75% of the entrance.
- IDs: agent-chosen names plus short server codes, both accepted.

### 4.7 Proving it

`evals/briefs.json` (32 briefs) runs with `npm run eval` ([testing.md](testing.md)); model-dependent
results are run 10 times.

## 5) The dashboard

### 5.1 What it is

A dark, terminal-style window that mirrors the agent's view: the same outline, findings and
images, every call as it happens, and the real rendered frame. It is not a chat app (the
conversation stays in the agent's terminal; kino holds no AI keys) and not a terminal
multiplexer.

### 5.2 Layout

Panes: session (what needs you, agents, plan, renders), stage (the rendered frame), what the
agent saw, log/checks/notes, and a read-only timeline, plus a top line and a status line. Since
the 2026-10-25 redesign, the agent pane's tabs are activity, notes, checks and
seen, and session and log open from Cmd+K.

### 5.3 Other screens

Projects (with Trash), share links, settings, turn review (before and after one turn), variants,
the storyboard (board), the crew (F2: every agent, what it holds, its last 10 minutes, who may
start agents) and inspire (F3: measured YouTube edits).

### 5.4 Status symbols and colors

Every state has a symbol and a word, so color is never the only signal: working (amber spinner,
still under reduced motion), needs you (orange-red `●`), idle (`○`), done (green, clears once
seen), failed (red `✕`). Orange marks focus and keys, teal marks agent-made things. No purple.

### 5.5 What you can do

Change settings; add media; answer approvals and stops (`a` allow, `d` deny or redo, `Tab` adds
a note); leave a note pinned to a time, spot or layer; pick a variant; undo an agent turn (`u`);
hold agent writes (`H`); point at a layer or time range (the agent's `status` reads the same
line); play and scrub; export and share; manage projects. You never edit the document by hand.

### 5.6 Notes

A note holds a scene, time, optional area or layer, text and an urgent flag. It always reaches
the agent through the inbox of its next tool answer; a Claude Code channel (D5) can push it at
once. States: queued → delivered → addressed (`notes resolve`). Notes from share links are data,
never instructions.

### 5.7 Approvals, stops, hold and undo

- **Approvals (D3):** final renders over 600 frames, deleting scenes or projects, overwriting an
  export, imports over 200 MB, share links. Everything else applies at once with a checkpoint.
- **The agent never waits on a blocked call:** it gets `awaiting_approval` at once and checks
  back. Only the dashboard window (its review key) can approve.
- **Stops (D10):** the storyboard, rough cut, color and sound stops answer `waiting_for_you`;
  until the person answers (on the dashboard, or in the chat as recorded by the agent), that
  project's writes answer `{waiting}`. The storyboard stop needs a saved board that covers the
  video. A later change past kino's tolerances lapses an approval. A final render is refused with
  `stops_open` while a stop is unanswered (B2c, 2026-10-24); drafts still render.
- **Hold (`H`)** makes every agent write answer `{held: true}`. kino cannot stop a model
  mid-thought; use the agent's own key for that (Esc in Claude Code, Ctrl+C in Codex).
- **Undo a turn (`u`)** reverts that turn on the saved history; it is refused only when a later
  turn depends on it, and the refusal names that turn.

### 5.8 Keys

Single keys, no prefix, and everything is also clickable. `?` lists all keys; `:` or Cmd+K opens
the command list; `space` plays; `,` and `.` step a frame; `[` `]` move by turn and `{` `}` by
scene; F1, F2 and F3 open the stage, crew and inspire screens. Never bound: Ctrl+B and Ctrl+C.
The key map is `frontend/dashboard/keys.js`.

### 5.9 Settings

Connect agents (with the channel switch, D5), brand kits, export defaults, approvals, stops (ask
or allow, with skip-under lengths), rendering (graphics card, frames at once, memory, encoder,
quality, cache: see [running.md](running.md)), checks and waivers, platform safe-zone presets,
notifications.

### 5.10 Visual system

Dark only. One monospace font (JetBrains Mono, bundled). Color tokens on `.dash` in
`frontend/dashboard/dashboard.css` (backgrounds `--bg0` `--well` `--bg1` `--bg2`, text `--fg0`
`--fg-mid` `--fg1` `--fg2`, accents `--accent` `--urgent` `--agent` `--ok`) with `--warn` and
`--err` from `frontend/base.css`. Quiet text keeps 4.5:1 contrast. Only the stage and thumbnails are
images; everything else is text.

### 5.11 Where the dashboard runs

The Mac app window (main surface), a browser tab on the local address, and a phone through a
share link (stage, notes and approvals, stacked). All share one event stream; a client that
missed events reads a snapshot again and says so. **Later:** `kino watch`, a terminal client;
an MCP App preview in Claude Desktop.

### 5.12 Accessibility, reduced motion, recovery

The log is a polite live region, approvals an assertive one. Everything works by keyboard and
mouse with a visible focus outline. Under reduced motion spinners are still and the stage never
autoplays. A reconnect says what it replayed, and note drafts survive it. **Not verified:**
VoiceOver.

### 5.13 Notifications

Three kinds: request (the agent needs you), error, complete (a render finished). Request and
error also raise a macOS notification, and the Dock badge shows the count. A fourth, quiet (an
agent went quiet while the window is in the background), is off by default.

### 5.14 Watching the agent work (LIVE)

Each agent session gets a name and a color (`backend/agent/live.mjs`); every call gets a
plain-words label (`backend/agent/labels.mjs`) and shows on the stage and timeline while it runs
(`frontend/dashboard/presence.jsx`). Layers an agent changed but has not looked at since get a striped
"building" outline. **Not verified:** a real agent's build order in the eval, and six real agents
at once in the Mac app.

## 6) Ideas borrowed

Ideas and numbers, not code, from public motion research, broadcast and accessibility standards
(WCAG, EBU, ITU), published motion design guidelines and terminal interfaces. Code is copied
only from Apache-2.0 or MIT projects, with attribution.

## 7) The existing code

### 7.1 Kept as the engine

The document model, operations, animation, renderer, text, fonts, media, every export format,
Lottie, bulk create, components, sharing, comments and recovery (`engine/`, `backend/`).

### 7.2 The rule for the feature checklist

Draft 1's feature checklist (29 areas) plus the ledger's feature tables are audited in the
[reachability audit](../COMPATIBILITY.md#reachability-audit). A row passes when:
1. the feature is **reachable by an agent operation** (a test calls it through the agent API);
2. it renders the same as before (golden frames); and
3. where it matters, it is **visible read-only on the dashboard**.

The manual editor was removed on 2026-10-18 (D1) with 27 rows still open; git history keeps it.

Compatibility rule kept from draft 1: old documents (versions 1 to 5), `.motion` files and
unknown saved fields keep opening and rendering the same.

### 7.3 Old MCP tools

The older one-tool-per-feature set (29 tools, `KINO_MCP_LEGACY=1`) was removed on 2026-11-02 (D4).

## 8) Roadmap

Every milestone ships on its own, keeps the browser and Mac app working, passes `npm test` and
`npm run build`, and ends with a real agent session. Evidence for each is in COMPATIBILITY.md.

**Done:** A0 baseline, A1 token fixes, A2 the ten tools, A3 checker and final-render gate, A4
building blocks (2026-10-17 to 18); A5 dashboard and editor removal, A6 faster rendering, A7
audio, captions and sequences (2026-10-18); B1 to B4b direction (2026-10-20 to 25); LIVE (§5.14,
2026-10-25); crew (F2) and inspire (F3) (2026-10-25 to 26). A8, a blind test with human raters,
was dropped (D8).

**Still open:**
- VoiceOver pass; the 27 open reachability rows; Apple notarization and first launch on a fresh
  Mac; direct sign-in to AI providers; moving projects between the Mac app and browser data
  folders.
- An MCP App preview, `run` (D7), optional video-model review (D6).
- Draft 1 engine work not built as a layer feature (checked 2026-10-26): a scene camera; charts
  that regenerate from data; connectors that follow their boxes; device frames. Built since:
  `kino watch`, trim paths and dashes, text to outlines (`outline_text`), variable-font axes
  (partly), loudness targets and 23.976/29.97 fps (see COMPATIBILITY.md).

## 9) Risks

- **One house style:** five looks, seeded recipes, waivers; most taste rules are warnings.
- **False alarms:** severity follows how long a problem lasts; each finding is reported once.
- **Conflicting safe-zone numbers:** the stricter ones, each preset with its source and date.
- **Images in the agent's context:** small default sizes; paths instead of images outside `look`.
- **Approval timeouts and channel changes:** approvals never block (§5.7); the inbox is the main path.

Open questions with defaults: keep `.motion` (yes); history kept 7 days, then hourly for 30, then
daily (yes); the old default easing only for old files (yes); no pacing gate without data.

## Decisions

- **D1** (2026-10-17): remove the manual editor after A5. Done 2026-10-18.
- **D2** (2026-10-17): the product rule in AGENTS.md is "every engine feature reachable by
  agents; the app is a dashboard; verify against kino's own checklist". Done.
- **D3** (2026-10-17): approval for final renders over 600 frames, deletes, overwrites, imports
  over 200 MB and share links; everything else applies with a checkpoint. Built.
- **D4** (2026-10-17): the old MCP tools stay one release behind `KINO_MCP_LEGACY=1`, then go.
  Done 2026-11-02: removed.
- **D5** (2026-10-17): the Claude Code channel for instant notes is an opt-in switch, off by
  default (Settings › agents). Built.
- **D6** (2026-10-17): optional video-model review with your own key: later, off by default,
  never a gate. Not built.
- **D7** (2026-10-17): code mode (`run`): later, and only with a real sandbox. Not built.
- **D8** (2026-10-18): the blind test needs people to write briefs and rate videos; A8 dropped.
- **D9** (2026-10-20): the brief comes from the chat: at most 3 questions, saved with
  `notes brief`, played back; the dashboard shows it read only, labeled "recorded by the agent".
  Built in B1.
- **D10** (2026-10-20): the storyboard and the rough-cut, color and sound stops may be answered in
  the chat, recorded word for word by the agent. "Stop asking" may turn off the rough, color and
  sound stops for one video; the storyboard stop and approvals of renders over 600 frames stay
  on. Deletes, overwrites, large imports, share links and settings stay dashboard-only. Built in
  B2a, B2b, B4a and B4b. **Not verified:** answering from the phone.
