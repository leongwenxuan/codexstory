# codexstory

`codexstory` is the Codex-CLI runtime fork of Overstory orchestration.

## Install

From this repository root:

```bash
bun install
cd codexstory
bun link
```

If you do not want to link globally, run commands with:

```bash
bun /Users/leongwenxuan/Desktop/overstory/codexstory/src/index.ts <command> ...
```

## Start

Inside your target project:

```bash
codexstory init
codexstory hooks install
codexstory coordinator start
```

Or spawn a worker directly:

```bash
codexstory sling <task-id> --capability builder --name builder-1
```

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
  `.codex/config.toml` rather than legacy-style event hooks.
  You can also run Codex through a session-log sidecar:
  `codexstory hooks run -- --model gpt-5-codex`
