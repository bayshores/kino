# Connecting an AI agent

How agents such as Claude Code and Codex drive kino: setup, the ten tools, the quality checker,
and the `kino` command line.

## Setup

kino must be running (the Mac app, or `npm run dev`). Then, in this folder:

```sh
node bin/kino.mjs setup        # or: npm link, then kino setup
```

`kino setup` finds Claude Code (`claude`) and Codex (`codex`) on your PATH, lists every change,
and asks before making any. For each agent it registers kino's MCP server with the agent's own
command (`claude mcp add --scope user kino …`, `codex mcp add kino …`) and copies the kino skill
(`skills/kino/`) to `~/.claude/skills/kino` or `~/.agents/skills/kino`. It can also add a `kino`
entry to this checkout's `.claude/launch.json`. `--dry-run` only prints the plan; `--yes` skips
the question. It never opens an agent's settings or credential files.

- **Claude Code plugin:** `.claude-plugin/` holds the plugin (the MCP server plus the skill) and a
  one-plugin marketplace: `/plugin marketplace add /path/to/kino`, then `/plugin install kino@kino`.
- **Codex** finds the skill in this folder through `.agents/skills/kino`, a link to `skills/kino`.
  Codex may ask you to approve kino's tool calls; in `codex exec`, which cannot ask, they fail. To
  let them run, add `default_tools_approval_mode = "approve"` under `[mcp_servers.kino]` in your
  Codex config yourself (`kino setup` does not change it).
- **Other MCP clients:** run `node bin/kino.mjs mcp` as a stdio server. An agent without the
  skill reads the same guide with `library {topic:"guide"}`, and each reference with
  `library {topic:"guide", name:"edits"}` (the reference's file name).
- **The dashboard's settings screen** (pane **1 agents**) shows the exact MCP configuration for
  this checkout. The agent keeps its own account; kino never reads its login or tokens. An MCP
  client on a hosted instance can use `KINO_SHARE_TOKEN` for a scoped file link or
  `KINO_OWNER_TOKEN` for operator access.

**The skill.** `skills/kino/SKILL.md` is short (under 7,000 characters): the loop, compose first,
the ten tools and the rules that matter most. The details are in `skills/kino/references/*.md`,
read only when a task needs one; `fields.md` lists every op's fields and is made by
`npm run skill:fields`. `backend/skill.test.mjs` checks the sizes and links, that `fields.md`
matches the ops, and runs every example.

## The ten tools

| Tool | What it does |
|---|---|
| `status` | The project as an outline: one line per layer with a short code (`L3`), where the video stands (`direction:` and `next:`), the plan, check counts, notes from you (`inbox`) and your selection. Layers the agent already read and that did not change are counted, not repeated. |
| `edit` | A list of operations saved as one revision. Layers, scenes and animations can be named (`title`, `title.in`) or coded (`L3`, `A2`, `s1`). A misspelled name with one close match is fixed and reported; otherwise the answer says "did you mean". The answer is a receipt: new names and codes, what changed, animation times, check counts. A refused edit saves nothing, lists every failing operation and gives a code (`E2`); `edit {retry:"E2", fix:{"3":{…}}}` sends it again with only the fixes. |
| `check` | The quality checker: errors (gates) and warnings, each with what was measured, what is required, and a fix as edit operations. `check {fix:"auto"}` applies the fixes marked (auto) as one revision. |
| `look` | Images of the saved project: a `sheet` (12 frames, at least one per shot when the footage has cuts), one `frame`, a `zoom` on one layer, a `strip` across one animation, a `compare` with an older revision, only the frames that `changed`, a video layer's whole `source` frame with its crop and the subject boxes the agent marked (`mark_subject`), or the storyboard (`board`, 4 shots a page). Images are also saved under `<data>/agent/out/`. |
| `inspect` | Exact fields of up to 10 layers or animations, chosen by name, code or selector (`text[fontSize>40]`, `*[name~=title]`, `animation[kind=in]`). |
| `render` | A video file from the saved project: `start` (draft or final), `wait`, `status`, `cancel`. `out` picks the folder; it must be an absolute path (the `kino` command turns a relative folder or `~` into one). |
| `library` | Operation fields and rules, easings, presets, fonts, imported media, effects, and the guide. |
| `history` | The agent's turns (edits grouped by time). `revert` undoes one turn and keeps later changes; `restore` brings back a saved revision. |
| `notes` | The plan and notes shared with you: `brief` (what you told the agent in the chat), `checkpoint` (a stop that waits for your answer), `answer` (your reply to a stop, recorded by the agent), `set_plan`, `add`, `reply`, `resolve`, `helper` (ask kino to start a helper agent). Your notes reach the agent in every answer's `inbox`. |
| `project` | `list`, `create`, `open`, `duplicate`, `archive` (to Trash), and `import` of a local image, video, audio or font file (for a video, the answer lists the shots kino found). |

Every tool calls `POST /api/agent/<verb>` on the running server (owner access only), so the
answers come from one place: `backend/agent/service.mjs`. The tool list is capped at 5,800
estimated tokens and the server instructions at 4,096 characters; `npm run mcp:budget` prints
both. An answer longer than about 8,000 tokens is saved to `<data>/agent/out/<project>/`, and the
agent gets its first three lines and the file path.

## Quality checks

`check` runs every rule in `engine/quality/` on each scene, with component copies drawn in place.
The rules and their numbers are in [the plan](agent-first-plan.md) §4.3 and §4.4, and
`library {topic:"rules", name:"quality"}` lists them for agents. Two rules render frames:
`contrast` measures the real pixels behind each text, and `flashing` counts flashes. The rest
read the timeline.

- **Errors and warnings.** Errors are gates: a final render is refused while one stands.
  Warnings are shown only. A problem that lasts 2 samples or less is info: counted, not listed.
- **Fixes.** Each finding has `measured`, `required` and a fix: an edit operation when the
  checker can work one out, otherwise an instruction. Safe fixes are marked (auto).
- **Waivers.** `{op:"waive_check", code, target, reason}` accepts one finding on purpose.
- **Promises.** A scene's `assertions` (`visible_by`, `before`, `inside_frame`) are checked like
  rules.
- **Sound sync.** After a final render with sound, `av_offset` compares the audio and video start
  times in the file (45 ms early to 125 ms late, ITU-R BT.1359).

## The command line

The `kino` command has the same verbs; `kino help` shows examples:

```sh
kino status
kino edit '[{"op":"update_layer","layer":"title","properties":{"fill":"#ff5500"}}]'
kino look sheet                       # prints the path of the saved PNG
kino check fix=auto                   # applies the fixes marked (auto)
kino history revert T3
kino notes add "Make the logo bigger" layer=logo --you
kino render start quality=final out=~/Movies && kino render wait
```

`--you` records the action as yours, so the agent sees it in its inbox. `--project <id>` acts on
that project instead of the open one, and `--json` prints the whole reply. These options go
before or after the verb. The client finds the server through `MOTION_API_URL` (with
`KINO_OWNER_TOKEN` when needed), then the Mac app's own connection file, then
`http://127.0.0.1:4781`.

## Agents kino starts

kino can start Claude Code (`claude -p`) or Codex (`codex exec`) from your own installs: started
by you on the crew screen (F2), by your notes, by a lead agent asking for a helper
(`notes {action:"helper"}`) or by a timer. Each gets a task, what it may do (everything, or look
and search only) and a budget (60 calls or 15 minutes unless you change it; past it kino holds the
agent and asks you). You can hold or stop any one agent. An agent's edit holds the layers it
changed for a while, and another agent's edit of them waits instead of saving. The code is
`backend/agent/crew.mjs` and `backend/agent/launcher.mjs`.

## The removed tool set

The earlier one-tool-per-feature set (`KINO_MCP_LEGACY=1`) was removed on 2026-11-02 (plan
decision D4). Every feature it reached is in the ten tools; `library {topic:"op", name}` gives
any operation's fields and rules from `backend/agent/operations.md`.
