# kino: notes for coding agents and contributors

kino is an open-source motion design engine that coding agents drive. Agents make and change
videos through ten tools; the app is a dashboard that shows their work. Setup and commands for
people: [README.md](README.md). Which file does what: [docs/code-map.md](docs/code-map.md).

## Commands

```sh
npm install                        # Node.js 22+, plus FFmpeg and Gifski (brew install ffmpeg gifski)
npm test -- --changed              # the tests related to your branch's changes
npm test -- backend/crew.test.mjs  # named test files
npm test                           # everything, about 8 minutes (CI runs it on every push)
npm run build                      # production build of the dashboard
npm run mcp:budget                 # size of the tool list an agent loads
npm run desktop                    # the Mac app; check UI changes here
```

## Layout rules

- `engine/` is shared by the server and the dashboard: plain JavaScript, no Node or DOM APIs.
  `frontend/` imports only from `engine/` and itself; `backend/`, `desktop/` and `bin/` never
  import from `frontend/`. `tests/repo-rules.test.mjs` enforces this.
- Tests sit next to the code they test (`*.test.js` in engine and frontend, `*.test.mjs` in
  backend); repository-wide and browser tests are in `tests/`.

## Product rules

- Every engine feature (editing, animation, import, export, templates, collaboration) stays
  reachable by agents through the ten tools and the `kino` CLI. People approve, hold, undo and
  leave notes in the dashboard; they do not edit by hand.
- A feature is done when a test shows the agent path and the rendered result, recorded in
  [COMPATIBILITY.md](COMPATIBILITY.md). A README line, a label or a unit test alone is not proof.
- No accounts: no signup, login, profile or billing. Sharing uses capability links. OAuth only for
  provider-supported third-party connections; never read another app's token cache.
- No simulated success, seeded fake projects, inert controls or placeholders. Test fixtures stay
  out of the default workspace.
- Include accessibility, recovery and reduced motion.

## Engineering rules

- No em dashes (U+2014) anywhere: code, comments, docs, UI text, commit messages. Use a colon,
  comma, parentheses or a new sentence (`tests/repo-rules.test.mjs`).
- One small test per behavior. Extend an existing test before adding a file; test functions
  directly before going through the server or a browser. A new test file runs in under 5 s (15 s
  with a browser or render). Sweeps over every recipe, look or format are hand-run scripts.
- When a tool or op changes, update `skills/kino/SKILL.md` in the same change and keep its
  examples runnable (`backend/skill.test.mjs` checks size and links).
- Agent answers stay small: the tool list within its budget, no answer over 8k tokens.
- Never run `kino setup` against a real home folder or real agent configs: use `--dry-run`, stub
  `claude`/`codex` binaries and a temporary home.
- Prefer focused modules, plain names and few dependencies; keep the data-to-screen flow readable
  for a junior developer.
- Markdown stays short: one topic per file, skill references under about 150 lines, other docs
  under about 400. COMPATIBILITY.md gets one short bullet per feature.
- Copy code only from Apache-2.0 or MIT projects, with attribution; keep asset licenses and credit.
- macOS shell is zsh: quote globs (`'--include=*.js'`), and quote words that start with `=`.
  There is no `timeout` command; use `perl -e 'alarm shift; exec @ARGV' 90 <command>`.
