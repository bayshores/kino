# Taste harness

Hand-run scripts that judge edits on taste, not defects. Not part of `npm test`; `tests/taste-harness.test.mjs` checks the pure parts in `lib.mjs`.

Nothing leaves this computer except the judge's calls to Claude (`claude -p`). Renders are never sent to any other model.

## 1. Build a packet per video

```sh
node evals/taste/packet.mjs <video.mp4> [--out <folder>] [--no-words]
```

Any MP4 works: a kino render or a downloaded reference edit. About 25 s for a 70 s video, one ffmpeg at a time. The folder (default `evals/taste/packets/<12 hex of the file's hash>`, ignored by Git) holds:

- `video.mp4`: a 540p copy with no metadata. Loudness is measured, not changed.
- `overview-NN.jpg`: 2 fps, 20 to 24 frames a sheet, each tagged with its time.
- `strips-NN.jpg`: 12 fps, 0.5 s each side of every cut (yellow tag = first frame after the cut), 5 cuts a sheet. Cuts come from ffmpeg `scdet` (score 10 or more, the strongest 24).
- `facts.json`:
  - loudness: integrated, range, true peak, and short-term / momentary every 0.5 s (ffmpeg `ebur128`);
  - cuts, shot lengths, frozen stretches (1 s or more with no change), brightness jumps away from cuts;
  - beat grid (`engine/beatDetection.js`) and song sections (`backend/song-shape.mjs`) of the final mix;
  - a transcript with word times when whisper.cpp and a model are installed (`backend/speech/transcribe.mjs`);
  - `voiceOverMusic`: each speech line's loudness against the 1.5 s before it (a rough voice-over-music level).
- `source.json`: the original path. The judge never sees it.

A 70 s video makes about 10 sheets, around 30k tokens with the facts.

## 2. Judge two packets

```sh
node evals/taste/judge.mjs <packet X> <packet Y> [--names x,y] [--samples 3]
```

- Each call copies only the sheets into a fresh folder as `A/` and `B/`, so no name or path tells which video is which, and runs `claude -p --restricted --tools Read` there.
- Both orders, 3 samples each (6 calls, 3 side by side). Scores are medians. A win counts only when the majority holds in both orders; otherwise the verdict is `same`. With fewer than 2 usable answers in an order the verdict is `too_few` (the ladder skips it); the report prints the samples used per order.
- Answers are JSON. The model sometimes puts double quotes inside a string or drops the last `}`; `answerJson` mends both. A call that still fails (timeout, CLI error, unparsable answer) is tried once more, with the reason in the log and in `failures`; an unparsable answer is kept whole in `results/failed.jsonl`.
- The rubric (`judgePrompt`): per video a one-line pitch, its 2 most memorable seconds and the moves that would fit any product; then -3 to +3 on storytelling, directing, uniqueness, impressiveness, quality, smoothness and audio mix, each citing times; then "which would the owner post?". A defect counts only if it would make a viewer stop watching. Safe is not a virtue.
- Sound is judged from numbers only (loudness curve, voice over music, song sections).
- `KINO_TASTE_MODEL` picks the model (default `opus`), `KINO_TASTE_JOBS` the calls side by side (default 3).
- The verdict (with the exact model ids the CLI used) is appended to `results/judged.jsonl` (ignored by Git) and printed as a short report. One pair costs 6 calls of about 40k tokens each: do not run it on many pairs at once.

## 3. Ladder

```sh
node evals/taste/ladder.mjs [--owner-weight 3]
```

Bradley-Terry ratings (Elo-like scale, 0 = average) over every `results/*.jsonl` verdict plus the owner's picks, written to `results/ladder.json` (ignored by Git). Owner picks are the truth: each counts as 3 judge verdicts. Every other pick by time is a judge example and goes into the ratings; the rest are held out and only compared with the judge. The judge counts as calibrated once it matches at least 16 of 20 held-out decisive picks.

## 4. First pass

```sh
node evals/taste/firstpass.mjs <brief> [--run-id <id>] [--dry-run]
```

One first-pass edit, made the way a person asks kino for it: a fresh agent, the person's one-line ask, the material and no owner turns. A brief is a JSON file, passed by path or kept as `briefs/<name>.json` (ignored by Git): `{ask, media: [paths], words?: [html pages], names?: {path: file name}, notes?}`. `--dry-run` copies the material and prints the agent's message.

Everything goes in `.local/taste/runs/<run-id>/`:

1. `media/`: copies of the brief's files (the sources are only read); a `words` page becomes plain text.
2. `data/`: a fresh kino data folder for a private kino server (`backend/index.mjs`, port picked by the system; your app and its data are never touched). Its settings (`data/agent/dashboard.json`): final render, export overwrite and large import `allow` (nobody is there to approve), renders into `out/`, no idle preview drawing, sound search on (licensed music). The four stops keep `ask`.
3. The agent: `claude -p` with the ask and the file list as the person's message, nothing more. It runs in a temporary folder outside this repository with `--restricted --tools Bash,Read,Agent --strict-mcp-config` (none of your settings, hooks, plugins or MCP servers). A `kino` command on its PATH talks to the private server (`MOTION_API_URL`). Restricted mode skips project skills, so `skills/kino/SKILL.md` goes in the appended system prompt, with its `references/` copied into the folder. Its file tools reach only that folder, `media/`, `out/` and `data/agent/out` (where `kino look` saves its images); Bash is not confined.
4. **No owner turns.** Whenever the agent ends its turn without a final MP4 in `out/` (it asked a question, or a stop answered `waiting_for_you`), the runner resumes the same session (`--resume`) with the person's reply `your call`. The agent records it as the stop's answer (`notes answer`) like any reply. At most 10 replies.
5. The run ends at a final MP4 (a name without `draft`), the time budget or the reply limit. `run.json` holds the MP4 (copied into `out/`), its length and size, the agent's final message, kino's `check` of the open project, cost (the session's `total_cost_usd`, which a resume carries on), time, replies and every call; `transcript.jsonl` is the agent's stream; `server.log` is kino's.

Env: `KINO_FIRSTPASS_MODEL` (default the `model` in `~/.claude/settings.json`), `KINO_FIRSTPASS_MINUTES` (time budget, default 45), `KINO_FIRSTPASS_REPLIES` (default 10). Uses your Claude Code login. Delete `data/` when the run has been judged.

## Owner picks: `picks.jsonl`

One JSON line per pick, written by hand (ignored by Git). The app's pick box keeps its own file (`picks.md`); the ladder reads both.

```json
{"at":"2026-10-29T20:00:00Z","left":"04ab7716ff98","right":"b4517d8f04ee","pick":"left","part":"all","words":["storytelling"],"names":{"04ab7716ff98":"edit-v1","b4517d8f04ee":"edit-v2"}}
```

- `left`, `right`: packet ids (the first 12 hex of the video file's SHA-256, `source.json` `id`).
- `pick`: `left`, `right`, `same` or `skip`.
- `part`: `all` (the whole edit), or `sound`, `picture`, `hook`, `payoff`, `how` for split picks. Only `all` picks go into the ladder; the others are read by hand.
- `words`: optional word chips, `names`: optional readable names, `blind`: false for a preference not picked blind.

