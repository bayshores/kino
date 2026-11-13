# Where to make a first change

Which file does what, for a first code change.

| File                               | Responsibility                                       |
| ---------------------------------- | ---------------------------------------------------- |
| `frontend/main.jsx` and `frontend/viewerNavigation.js` | Open the dashboard for the owner and the viewer for share links (`/?editor` opens the dashboard) |
| `frontend/dashboard/` | The dashboard: panes, screens (projects and Trash, shares, settings), keys, notes, approvals and the live event stream |
| `frontend/dashboard/stops.jsx` | The stop card (the agent's ask, stills of the revision it showed or, for the storyboard, the board screen (`board.jsx`), `a` approve, `Tab` approve with a note, `d` redo with a note), the stop lines with `reopen` and `keep asking` and the footnote on chat answers, the phone's cards for a stop that just stopped waiting and for one waiting in another project, and the stop settings |
| `frontend/dashboard/board.jsx` and `boardRows.js` | The board screen (`BoardView`, on the stop card and `:board`): a header line, the rough cut (the shots played from their own files, cropped, at their directed lengths), the shot panel (first and last frame, length, options A to C, remove shot, a note with `c`; one sentence for a screen reader), and the timeline (story roles, shots by length, text and sound lanes); the agent's calls folded away. `boardRows.js` turns the board data and the person's directions into words, chips, directed shots and footage boxes (plain functions, tested on their own) |
| `frontend/dashboard/tries.jsx`, `tryRows.js` and `tries.css` | The try options screen (`:try`, its "needs you" row, the board's `try options` button): the rounds so far and planned, the question, 2 to 4 versions of a moment on one clock, pick, none of these or skip. `backend/agent/tries.mjs` reads `notes {action:"try"}`, renders each option's 2 s clip and sends the pick to the inbox |
| `frontend/dashboard/library.jsx`, `libraryRows.js` and `library.css` | The library screen (F4): everything an agent can use by what it does or by kind, a still and a playing sample of each, what this video uses, and "ask for this" notes. `backend/agent/library-catalog.mjs` lists the entries and each sample's ops; the service builds the sample (`librarySample`) and draws its still (`libraryStill`); `library-media.mjs` draws the pictures, clip and look the samples use, once, into the media folder |
| `frontend/dashboard/presence.jsx`, `presence.js` and `presence.css` | The live view (milestone LIVE): each agent's tag (`Nova · look at 1.0–2.0 s`) and outline on the stage, the flash on what a write changed, the striped "building" outline, the line or tinted range on the timeline, and the polite screen-reader line (`PresenceAnnouncer`). `presence.js` holds the rules as plain functions (what is shown and for how long, where tags go, timeline pixels, the reduced-motion steady outline, the announcer's 4 s throttle); `state.js` builds `data.live` from the stream and finds the agents that went quiet (`quietAgents`) |
| `backend/dashboard-routes.mjs` | The dashboard's routes; `POST stops` answers a waiting stop (`answer`), reopens an answer (`reopen`) and undoes "stop asking" (`keep_asking`); `GET board` is one page of a revision's storyboard as `look board` draws it; `GET board-data` is the board screen's data (JSON) and `GET board-shot` one shot's source frame or cropped still (PNG); the snapshot's `waitingStops` lists the stops waiting in the projects agents work on |
| `engine/operations.js` | Apply scene, layer, animation, component and bulk edits through the shared document rules |
| `engine/model.js` and `engine/schema.js` | Document format, defaults, and validation            |
| `engine/documentMigration.js` | Migrate legacy spacing/backgrounds and box styles while preserving earlier content and timing |
| `engine/effects/` | Shared effect catalog, typed parameters, timing, cached maps, SVG renderers, and original static tile previews |
| `engine/letterSpacing.js`             | Letter spacing in percent of the font size, and its limit |
| `engine/lineHeight.js`                | Line height as a multiple of the font size, its limits, and the preset's To |
| `engine/textChange.js` and `engine/textChangeDraw.js` | Change text: its effects, schedule and limits, and the strings (with their units and states) to draw at a time |
| `engine/counterFormat.js`             | Reading a number's format from a text ($1,234.50kg, 0042) and writing numbers in it |
| `engine/counter.js` and `engine/counterSchedule.js` | Counter: defaults, limits, the number after each step, and when each number shows with its In and Out effects |
| `engine/animation.js`                 | Presets, interpolation, and operation timing |
| `engine/easing.js`                    | Shared easing curves, intensity, saved-easing checks and exact Bounce turn times |
| `engine/animationShift.js` | Move absolute animated X/Y endpoints with a layer or an instance position override |
| `engine/render.js`                    | Shared SVG scene renderer                            |
| `engine/geometry.js`                  | Canvas/group coordinate transforms                   |
| `engine/boxes.js` | Bounds around points and the union of several boxes in scene pixels |
| `frontend/canvasLayerState.js` | Measure drawn text for canvas outlines and hits without saving computed dimensions |
| `engine/transformMath.js` | Resize math: the fixed point, the new box, and typed sizes |
| `engine/multiTransform.js` | `multi_transform`: selection roots, drawn bounds, shared transforms and world-axis nudges |
| `engine/selectionTransformDrag.js` | Shared resizing, with proportional fallback for unsafe stretches |
| `engine/selectionTransformFields.js` | Numeric scale and rotation of several layers around one of nine anchors |
| `engine/grouping.js`, `engine/reparent.js` and `engine/groupResize.js` | Group/ungroup without moving layers, and group resizing |
| `engine/masking.js`                   | `create_mask` and `remove_mask` on top of grouping |
| `engine/shapes.js`                    | Shared cubic geometry for corners, arcs, rings and stars |
| `engine/shapeConversion.js`           | Primitive conversion with preserved identity and paint bounds |
| `engine/animationCompatibility.js`    | Shared compatibility checks for retained shape operations |
| `engine/animationSelection.js` | Several animations at once: their timeline order and owners |
| `engine/animationEnabled.js`          | Turning an operation off for playback: the `enabled` flag |
| `engine/stagger.js` | Stagger: items and layer blocks, orders and the fit check |
| `engine/linkedComponents.js` and `engine/playback.js` | Linked scene expansion, playback clocks and visibility |
| `engine/componentOverrides.js` | Allowed instance fields, nested path resolution, normalization, reset, ID remapping and media/font references |
| `engine/createComponent.js` | Extract selected layers into a transparent main component and replace them with a linked instance |
| `engine/sceneBackground.js` | Scene paint and Color evaluation, animation owners and ordinary media-background layer geometry |
| `engine/sceneAnimationEdit.js` | Validate whole layer and background animation edits |
| `engine/sceneDuplication.js` | Duplicate scenes with fresh IDs and one copied background, preserving linked component content |
| `engine/csv.js` | Bounded CSV parsing/writing, delimiter detection, quotes, newlines and spreadsheet formula protection |
| `engine/bulkCreate.js` | Eligible columns, templates, row plans, linked variants, re-import, optional deletion and result summaries |
| `engine/vectorPath.js` | Curve parsing, interpolation and bounds |
| `engine/svgImport.js`                 | Validated editable SVG import, and placing its layers |
| `engine/layerClipboard.js`            | Copy and paste of layers and animations: the clipboard format, new IDs, media and font references |
| `engine/fonts.js` and `engine/textLayout.js` | Real font shaping, glyph outlines and line layout |
| `frontend/components/ScenePreview.jsx` | Scene rendering and media playback in the viewer |
| `frontend/Viewer.jsx` and `frontend/useViewerDocument.js` | The share-link viewer: scene browsing, phone cards and live updates |
| `frontend/ViewerComments.jsx` and `frontend/components/CommentsPanel.jsx` | Comments in the viewer for comment and edit links: pins on the frame, threads, replies, resolve |
| `engine/selection.js`                 | Group-first picking for notes on the stage, and layer outlines (quads) for presence and transforms |
| `engine/layerTree.js`                 | Locks and hides inherited from groups |
| `engine/layerOrder.js`                | `reorder_layer`, `move_layers` and `set_layer_flags`: moving layers between groups, front/back order, hide and lock, mask checks |
| `frontend/layerBounds.js`               | The box around layers on the dashboard stage (rotation, parents, components, animation) |
| `engine/multiEdit.js`                 | Several layers at once: shared or Mixed values, one edit for all |
| `engine/exportOptions.js` | Export presets, dimensions and frame sampling |
| `engine/scriptRuntime.js` | The runtime a script layer's drawing module runs in, inside a sandboxed frame: its page and policy, `setup`/`draw` calls, seeded `Math.random`, the frame clock, image inputs, errors with phase and line, PNG or ImageBitmap out, empty frames; the time limits |
| `backend/script-frames.mjs` | `createScriptRenderer`: draws a script layer's frames to PNG in one long-lived Electron worker, keeps a module mounted while nothing changed, and stops a script that takes too long |
| `backend/script-layer-frames.mjs` | A scene's script layers for an export, still or look frame: `sceneScriptFrames` draws the frames each output frame needs before its SVG (pixel ratio from the output size, image inputs read from the media folder), caches them, and turns a failed frame into a warning sentence (a final render's error); `testDrawScriptLayers` is the edit receipt's 3-frame test draw and `issuesAt` gives the check rules in `engine/quality/rules/script.js` their errors and empty frames; one shared renderer per process, closed after a quiet minute (`closeScriptRenderer`) |
| `desktop/script-worker.cjs` and `desktop/script-page.cjs` | The script worker's Electron process (hidden window, in-memory session, every request but its own pages cancelled, no permissions or navigation, the setup and draw watchdog) and its page's preload, which passes messages to the sandboxed frame |
| `backend/index.mjs`                 | HTTP API, uploads, and WebSocket connections         |
| `backend/store.mjs`                 | Atomic persistent storage and revision conflicts     |
| `backend/shares.mjs`                | Anonymous capability links, roles, hashes and revocation |
| `backend/media-use.mjs`             | Which files' sharing links may use an uploaded media file |
| `backend/bulk-create-media.mjs` | Recover permitted saved-image measurements for CSV operations without reading named local files |
| `backend/svg-asset.mjs` | Normalize static SVG image uploads, outline bundled-font text and rasterize assets for export |
| `backend/export.mjs`                | Rasterization, video encoding, and Lottie conversion |
| `backend/video-windows.mjs`         | A long export's video pictures, extracted a window of frames at a time and deleted when drawn |
| `backend/export-document.mjs` | Recognize version 3 scene-only exports while keeping older requests' letter-spacing contract |
| `backend/lottie-images.mjs`         | Real bitmap decoding, density selection, and resizing |
| `backend/lottie-png.mjs`            | Lossless RGBA PNG encoding for embedded Lottie assets |
| `backend/export-batches.mjs`         | Immutable scene snapshots, cancellable queues and result files |
| `backend/zip.mjs` and `backend/png-sequence.mjs` | Disk-streamed ZIP archives and lossless frame sequences |
| `engine/stillFrame.js`                | The still PNG time and design view: clamping, batch rule, thumbnails, validation |
| `backend/lottie-shapes.mjs`          | Native curve, gradient, fill and stroke serialization |
| `engine/paints.js`                    | Shared gradient coordinates for previews and exports |
| `engine/paintInterpolation.js`        | How a Color or Stroke animation mixes solids and gradients |
| `backend/lottie-paints.mjs`          | One stop count and one type per Lottie gradient track |
| `engine/shadowInterpolation.js`       | How a Shadow animation mixes drop shadows, and its preset |
| `engine/resizeAnchor.js`              | Resize animation anchor points, its preset and refusals |
| `backend/lottie-shadow.mjs`          | Per-frame Lottie Drop Shadow values from x/y offsets |
| `backend/lottie-vector.mjs`          | Native stroke matte pairs and shared layer/unit opacity |
| `backend/lottie-bounds.mjs`          | Conservative vector bounds for unclipped compositions |
| `backend/lottie-text.mjs`            | Portable outlined text with sampled unit motion |
| `backend/lottie-effects.mjs`         | Native blur, shadow parameters, and padded effect bounds |
| `backend/lottie-media-frames.mjs`    | Real video/GIF frame decoding for Lottie |
| `engine/playback.js` and `engine/mediaPlay.js` | Media Play timing, Freeze, GIF frame clock and sync |
| `backend/media-probe.mjs` and `backend/gif-frame-cache.mjs` | Media measurement, GIF frame timelines, and decoded frame cache |
| `backend/footage/sounds.mjs` | A clip's sounds besides words (the macOS sound classifier, kino-measure `--sounds`), kept beside the file as `.sounds-v1` |
| `backend/shot-detection.mjs` | The shots in an imported video: one FFmpeg `scdet` run, flashes and too-short shots merged away, the check that FFmpeg has `scdet` and `signalstats`, shots found later for older imports, and the `shots:` line of the import answer |
| `backend/fonts.mjs`                  | Bundled and permitted uploaded font catalogs |
| `backend/mcp.mjs`                   | MCP tools that call the same real HTTP API           |
| `backend/agent/service.mjs` | The ten agent verbs behind `POST /api/agent/<verb>`: outline, receipts, turns, notes, renders |
| `backend/agent/refs.mjs` and `backend/agent/translate.mjs` | Short codes and names for layers, scenes and animations, "did you mean", and op field aliases |
| `backend/agent/common-mistakes.mjs` and `op-examples.mjs` | Shapes agents often send on a first try, read the one way they can mean (listed in `fixed`) or refused with the way that works; one working example op for each op, sent with a refusal |
| `backend/agent/outline.mjs`, `inspect.mjs` and `checks.mjs` | The project outline, inspect selectors, and the check report (counts, waivers, auto fixes) |
| `engine/quality/` | The quality checker: the tool-neutral model (`model.js`), the kino adapter (`kinoTimeline.js`), and the rules (`rules/`, `pixels.js`) |
| `backend/agent/quality.mjs` and `av-offset.mjs` | Runs the checker for agents (names, fix ops, waivers, cache) and the sound-sync check on rendered files |
| `evals/direction.mjs` and `evals/board.mjs` | The eval checkers for a conversation (`evals/run.mjs` plays the person with scripted replies): the brief's rules (`checkDirection`), and for a board brief the storyboard ask (`checkBoard`: sent as written, "my calls", a true fresh-eyes line, one round of questions) |
| `evals/agent-env.mjs` and `evals/tokens.mjs` | The eval runner's isolated agent environment (empty home and config folders, only an API key) and Codex token counts priced from `evals/prices.json` |
| `backend/agent/look.mjs` | Contact sheets (tiles shared by shot when the footage has cuts), frames, zooms, strips, comparisons, source views (a clip's whole frame with its grid, crop and subject boxes) and the storyboard's page image (`boardImage`), with a frame cache |
| `engine/sceneShots.js` | A scene's shots in scene seconds, from its video layers' file shots (through speed, reverse and trims), and the tiles a per-shot sheet shows |
| `engine/pin.js`, `backend/agent/track-operation.mjs`, `backend/cutout/track.mjs` | The track op follows an object with Apple Vision (kino-cutout `--track`) into `scene.tracks`; the pin op copies a track onto `layer.pin`, which `evaluateLayer` follows; check `track_lost` |
| `backend/recorder/kino-recorder.swift`, `backend/recorder/recorder.mjs` | Screen recording: the Swift helper captures the screen without the pointer and logs pointer, clicks, keys and marks over JSON lines; `recorder.mjs` runs it for `project {action:"record"}`, adds the video to the library with its `.recording.json` next to it, and keeps a folder a crash left |
| `engine/recording.js`, `engine/blocks/moves/recording.js` | A recording's compact data on a video layer (`layer.recording`) and what the `screen-recording` move builds from it: click zooms on one clamped spring, kino's smoothed pointer, click rings |
| `engine/sourceView.js` | Source views: where the crop sits on a video layer's source frame (in % of the source), the subject boxes at a moment of the file, and the checks on `subjectBoxes` |
| `engine/board.js` | The storyboard field in the project document (`board`): its shape and limits, the music span it must cover, and the gap and overlap sentences |
| `engine/boardMeasure.js` | The storyboard's numbers for one shot: how much of each subject box is inside the crop, its distance from the crop edge, the eye height, and the flags |
| `backend/agent/state.mjs` | Per-project agent state: codes, turns, plan, the brief, notes, seen layers and the approved storyboards (`boards`) |
| `backend/agent/live.mjs` | The live view's server memory (milestone LIVE): each agent's name and color from its `x-kino-session` (`identify`, `NAMES`, `PALETTE`, `cleanKind`), its latest presence, and the "building" marks (layers saved this turn that no look covered; `layerWindow`, `coveredLayers`, `touchedLayers`). Kept in memory only. Not `backend/presence.mjs`, which tracks people's cursors |
| `backend/agent/labels.mjs` | Plain words for every agent call (`callLabel`: `look at 1.0–2.0 s`, `move Logo`; no paths, URLs or share links, at most 60 characters), what a call is about (`callTarget`), and the pointing line the agent's `status` and the dashboard both show (`pointingText`) |
| `backend/agent/brief.mjs` | The brief from the chat (`notes brief`): its lines, the quote and "you" rules, the reply count, and the `direction:` and `next:` lines of `status` |
| `backend/agent/stops.mjs` | The stops (`notes checkpoint`, `notes answer`): which stops a video has, their order, the ask text, chat answers and their refusals, answers on the dashboard and reopen (with the inbox lines the agent gets; an approved storyboard is frozen from the chat and from the dashboard alike), "stop asking" and its undo, the `direction:` lines while a stop is open, and the stops a final render waits for (`openStops`, `finalRefusal`); the storyboard stop's own rules (a saved board, open items and "your call", the approved copy) |
| `backend/agent/board.mjs` | The approved storyboard: the frozen copy, what lapses it (by field, 6 frames, 5% of the frame width) and the `revision:` lines for smaller changes; the shots named in the person's words (`namedShots`) and what changed after a redo (`shotChanges`) |
| `backend/agent/board-data.mjs` | The board screen's data (`boardData`): the header (board rev, shots, length, aspect, platform), the brief's purpose, the calls and open questions, the stop's answer and fresh-eyes check, and each shot's layers, media, measured numbers and change |
| `backend/agent/board-text.mjs` and `board-look.mjs` | The storyboard's chat text (one sentence a shot with kino's numbers, flagged shots and "my calls" first, the fresh-eyes line, and after a redo what changed as asked, without being asked, or not at all) and `look {mode:"board"}` (pages of 4 shots, the text and the data; `boardShotImage` draws one shot's picture for the board screen) |
| `backend/agent/board-pace.mjs` and `engine/cutFacts.js` | The board's pace on each side of the song's drop beside the references', the beat times after it and `board {snap:"beats"}`; per-cut brightness and hue facts as pure functions |
| `backend/agent/tools.mjs` and `backend/agent/client.mjs` | The ten MCP tool definitions and the client they share with the command line; `actions.mjs` holds the notes actions and library topics both accept, `agent-session.mjs` names the agent a call works for |
| `backend/integration.mjs` | The one file other apps import to drive kino (the agent client, the document builders, the format version and upload limit); its names stay fixed while `INTEGRATION_VERSION` does |
| `bin/kino.mjs` and `bin/setup.mjs` | The `kino` command line and `kino setup` |
| `skills/kino/SKILL.md`, `skills/kino/references/` and `.claude-plugin/` | The agent skill (a short SKILL.md that links one reference per topic), and the Claude Code plugin that ships it with the MCP server. `.agents/skills/kino` is a link to the same folder, for Codex |
| `scripts/field-sheet.mjs` | Writes `skills/kino/references/fields.md` (every op and its fields) from the agent service (`npm run skill:fields`) |
| `desktop/main.mjs` and `desktop/preload.cjs` | Sandboxed Mac windows, the local service, and the `kinoDesktop` bridge the pages use (badge, service status, stored settings) |
| `desktop/navigation.mjs`           | Keeps Mac windows on the kino page, including when a file is dropped |
| `desktop/mcp.mjs`                  | Agent connection through the packaged Electron runtime |
| `desktop/mcp-launch.mjs`, `desktop/mcpb.mjs` and `scripts/mcpb-pack.mjs` | How an agent starts kino's MCP server from the app (one function), and the Claude Desktop `.mcpb` bundle built from it (`npm run mcpb:pack`) |
| `desktop/agent-connect.mjs` and `engine/agentLinks.js` | Settings opens the Claude Desktop bundle or a Cursor or VS Code install link; the link builders |
| `desktop/settings.mjs` | The Mac app's private settings store |

## A first change

For example, change a new rectangle's defaults in `createLayer` in
`engine/model.js`, then ask an agent to add a rectangle and watch it on the
dashboard. Existing documents keep their saved properties. Page styles are in
`frontend/base.css`, `frontend/Viewer.css`, `frontend/dashboard/dashboard.css` and each
component's CSS.
