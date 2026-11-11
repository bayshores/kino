# Controls: how this video asks the person

The person can say, for one video, which stops wait for them and which go on. Save what they
said in the brief:

```
notes {action:"brief", fields:{controls:{rough:"go", skip_under:{board:30}, quote:"<their exact words>"}}}
```

| Control | Values | Without it |
|---|---|---|
| `questions` | `"wait"` or `"go"` | up to 3 questions (1 under 8 s) |
| `board`, `rough`, `color`, `sound` | `"wait"` or `"go"` | the person's settings (ask) |
| `skip_under` | `{board:30}`: whole seconds per stop, 0 to 3600 | settings: board 8 s, others 15 s |
| `quote` | the person's words, up to 120 characters | |

- `"go"` lets the stop pass without waiting; the person sees one inbox line with their words.
  The storyboard still needs a saved board. `questions:"go"` means no questions: guess the
  missing lines.
- `"wait"` makes the stop ask even when the person's settings allow it.
- A stop under its `skip_under` length is skipped for this video.
- Asking the person less (`"go"`, a longer `skip_under`) needs `quote`: their words, copied from
  the chat. Asking more needs none. Never set a stop to `"go"` on your own.
- `null` removes one value (`{rough:null}`); `controls:null` removes them all.
- Saving controls keeps the brief's revision, so a confirmed brief stays confirmed.
- The save's answer names the controls and every step they skip; `status` shows one
  `controls (you): ...` line while any is set.
- A round that went on by `"go"` asks again once the control is back to `"wait"`.
- Only these controls exist. Counts, pace, feel and a time cap are refused until kino acts on them.
