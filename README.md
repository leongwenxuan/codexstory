# codexstory (MVP)

`codexstory` is a Codex-CLI runtime fork of Overstory orchestration.

## MVP Commands

- `codexstory init`
- `codexstory sling`
- `codexstory mail`
- `codexstory merge`
- `codexstory prime`
- `codexstory status`
- `codexstory stop`
- `codexstory worktree`
- `codexstory coordinator`
- `codexstory supervisor`
- `codexstory monitor`
- `codexstory hooks`

## Runtime Mapping

- Interactive worker runtime: `codex --cd <path>`
- Non-interactive AI runtime: `codex exec --cd <path> <prompt>`
- State root: `.codexstory/`
- Worker overlay: `CODEXSTORY.md` in each worktree

## Parity Notes

- Command surface now matches Overstory's command set.
- `costs` and `metrics` are enabled.
- Hook lifecycle parity remains bounded by Codex capabilities:
  `codexstory hooks` installs project-level Codex `notify` integration via
  `.codex/config.toml` rather than Claude-style event hooks.
  You can also run Codex through a session-log sidecar:
  `codexstory hooks run -- --model gpt-5-codex`
