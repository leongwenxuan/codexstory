# codexstory

`codexstory` helps you run and manage multiple Codex agents for real project work.

This README is intentionally simple. If you follow it top to bottom, you should be able to run your first agent.

## 5-Minute Quickstart

If you only want the fastest path, do this:

```bash
# 1) Install in this repo
bun install
bun link

# 2) Go to your target project
cd /path/to/your/project

# 3) Initialize codexstory
codexstory init
codexstory hooks install

# 4) Start dispatcher (stable queue mode)
codexstory dispatcher start --background

# 5) Spawn one worker (replace with a real task id)
codexstory sling <task-id> --capability builder --name builder-1

# 6) Check everything is running
codexstory status
codexstory dispatcher status
```

When done:

```bash
codexstory stop builder-1
codexstory dispatcher stop
```

## 1. What You Need

- macOS/Linux terminal
- `bun` installed
- `git` installed
- `tmux` installed
- `codex` CLI installed and authenticated

Quick check:

```bash
bun --version
git --version
tmux -V
codex --version
```

If one command fails, install that tool first.

## 2. Install codexstory

From this repo root:

```bash
bun install
bun link
```

Now `codexstory` should be available globally:

```bash
codexstory --help
```

If you do not want global link, run with bun directly:

```bash
bun src/index.ts --help
```

## 3. Initialize In Your Project

Go to the project where you want agents to work:

```bash
cd /path/to/your/project
codexstory init
codexstory hooks install
```

This creates `.codexstory/` and runtime config.

## 4. Start The Main Orchestrator (Easy Mode)

```bash
codexstory coordinator start
```

Check status:

```bash
codexstory status
```

Stop when done:

```bash
codexstory coordinator stop
```

## 5. Spawn One Worker Manually (Fast Test)

Use a real task id from your tracker:

```bash
codexstory sling <task-id> --capability builder --name builder-1
```

Examples:

```bash
codexstory sling beads-123 --capability builder --name builder-1
codexstory sling beads-124 --capability scout --name scout-1
```

See active workers:

```bash
codexstory status
```

Stop one worker:

```bash
codexstory stop builder-1
```

## 6. Queue + Dispatcher (Recommended For Stability)

`codexstory` now supports queued spawns with retries and dead-letter handling.

Start dispatcher in background:

```bash
codexstory dispatcher start --background
```

Check dispatcher:

```bash
codexstory dispatcher status
```

Queue a spawn only (do not run immediately):

```bash
codexstory sling <task-id> --name builder-2 --enqueue-only
```

Dead-letter queue tools:

```bash
codexstory dispatcher dlq list
codexstory dispatcher dlq replay --request <request-id>
```

Stop dispatcher:

```bash
codexstory dispatcher stop
```

## 7. Most Used Commands

- `codexstory init`
- `codexstory status`
- `codexstory sling ...`
- `codexstory stop <agent>`
- `codexstory mail ...`
- `codexstory merge`
- `codexstory coordinator start|stop|status`
- `codexstory dispatcher start|stop|status`
- `codexstory dispatcher dlq list|replay`
- `codexstory doctor`

## 8. If Something Breaks

Run health checks:

```bash
codexstory doctor
```

Useful diagnostics:

```bash
codexstory logs --help
codexstory trace --help
codexstory errors --help
```

Common fix path:

1. `codexstory status`
2. `codexstory dispatcher status`
3. `codexstory doctor`
4. `codexstory dispatcher dlq list`

## 9. Runtime Notes

- State folder: `.codexstory/`
- Worker instructions file in each worktree: `CODEXSTORY.md`
- Interactive worker runtime: `codex --cd <path>`
- Hook runner mode: `codexstory hooks run -- --model gpt-5-codex`
