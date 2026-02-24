/**
 * CLI command: codexstory hooks install|uninstall|status
 *
 * Codex CLI uses config.toml + notify, not Claude-style lifecycle hook files.
 * This command manages a project-local `.codex/config.toml` notify command.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";

interface HookEntry {
	matcher: string;
	hooks: ReadonlyArray<{ type: string; command: string }>;
}

function isDuplicateEntry(a: HookEntry, b: HookEntry): boolean {
	if (a.matcher !== b.matcher) return false;
	if (a.hooks.length !== b.hooks.length) return false;
	return a.hooks.every((cmd, i) => {
		const bCmd = b.hooks[i];
		return bCmd !== undefined && bCmd.type === cmd.type && bCmd.command === cmd.command;
	});
}

export function mergeHooksByEventType(
	existing: Record<string, unknown[]>,
	incoming: Record<string, unknown[]>,
): Record<string, unknown[]> {
	const merged: Record<string, unknown[]> = { ...existing };

	for (const [eventType, incomingEntries] of Object.entries(incoming)) {
		if (!(eventType in merged)) {
			merged[eventType] = incomingEntries;
			continue;
		}

		const existingEntries = merged[eventType] ?? [];
		const toAdd: unknown[] = [];

		for (const entry of incomingEntries) {
			const incomingEntry = entry as HookEntry;
			const isDupe = existingEntries.some((e) => isDuplicateEntry(e as HookEntry, incomingEntry));
			if (!isDupe) {
				toAdd.push(entry);
			}
		}

		merged[eventType] = [...existingEntries, ...toAdd];
	}

	return merged;
}

const NOTIFY_CMD = 'notify = ["bash", "-lc", "codexstory mail check --inject --agent orchestrator || true"]';

const HOOKS_HELP = `codexstory hooks — Manage Codex notify integration

Usage: codexstory hooks <subcommand>

Subcommands:
  install                  Install Codex notify command in .codex/config.toml
  uninstall                Remove Codex notify command from .codex/config.toml
  status                   Check notify installation status
  run                      Launch codex with session-log recording sidecar

Options:
  --json                   Output as JSON
  --help, -h               Show this help

Notes:
  Codex does not currently expose Claude-style lifecycle hook events.
  codexstory uses official Codex capabilities instead:
  - project notify in .codex/config.toml
  - optional session-log sidecar via \`codexstory hooks run\``;

function isCodexstoryNotifyLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("notify =") && trimmed.includes("codexstory mail check --inject");
}

async function installHooks(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const config = await loadConfig(process.cwd());
	const codexDir = join(config.project.root, ".codex");
	const targetPath = join(codexDir, "config.toml");
	await mkdir(codexDir, { recursive: true });

	const file = Bun.file(targetPath);
	const exists = await file.exists();
	const current = exists ? await file.text() : "";
	const lines = current.length > 0 ? current.split(/\r?\n/) : [];

	if (lines.some((line) => isCodexstoryNotifyLine(line))) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ installed: true, path: targetPath, changed: false })}\n`);
		} else {
			process.stdout.write(`Notify already installed in ${targetPath}\n`);
		}
		return;
	}

	const withoutNotify = lines.filter((line) => !line.trim().startsWith("notify ="));
	const finalLines = [...withoutNotify.filter((line) => line.length > 0), NOTIFY_CMD, ""];
	await Bun.write(targetPath, `${finalLines.join("\n")}\n`);

	if (json) {
		process.stdout.write(`${JSON.stringify({ installed: true, path: targetPath, changed: true })}\n`);
	} else {
		process.stdout.write(`✓ Installed Codex notify integration to ${targetPath}\n`);
	}
}

async function uninstallHooks(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const config = await loadConfig(process.cwd());
	const targetPath = join(config.project.root, ".codex", "config.toml");
	const file = Bun.file(targetPath);
	if (!(await file.exists())) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ installed: false, path: targetPath, changed: false })}\n`);
		} else {
			process.stdout.write(`No ${targetPath} found — nothing to uninstall.\n`);
		}
		return;
	}

	const current = await file.text();
	const lines = current.split(/\r?\n/);
	const filtered = lines.filter((line) => !isCodexstoryNotifyLine(line));
	const changed = filtered.length !== lines.length;
	await Bun.write(targetPath, `${filtered.join("\n").replace(/\n+$/, "\n")}`);

	if (json) {
		process.stdout.write(`${JSON.stringify({ installed: false, path: targetPath, changed })}\n`);
	} else {
		process.stdout.write(
			changed
				? `✓ Removed Codex notify integration from ${targetPath}\n`
				: `No codexstory notify integration found in ${targetPath}\n`,
		);
	}
}

async function statusHooks(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const config = await loadConfig(process.cwd());
	const globalPath = join(process.env.HOME ?? "~", ".codex", "config.toml");
	const projectPath = join(config.project.root, ".codex", "config.toml");

	const globalExists = await Bun.file(globalPath).exists();
	const projectExists = await Bun.file(projectPath).exists();
	const projectContent = projectExists ? await Bun.file(projectPath).text() : "";
	const installed = projectContent.split(/\r?\n/).some((line) => isCodexstoryNotifyLine(line));

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				installed,
				mode: "notify",
				globalConfigPath: globalPath,
				globalConfigExists: globalExists,
				projectConfigPath: projectPath,
				projectConfigExists: projectExists,
			})}\n`,
		);
		return;
	}

	process.stdout.write(`Codex global config: ${globalPath} (${globalExists ? "present" : "missing"})\n`);
	process.stdout.write(`Codex project config: ${projectPath} (${projectExists ? "present" : "missing"})\n`);
	process.stdout.write(`codexstory notify installed: ${installed ? "yes" : "no"}\n`);
	if (!installed) {
		process.stdout.write("Run `codexstory hooks install` to add project-level notify integration.\n");
	}
}

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

async function runHooks(args: string[]): Promise<void> {
	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const agent = getFlag(args, "--agent") ?? "orchestrator";
	const pollMsRaw = getFlag(args, "--poll-ms");
	const pollMs = pollMsRaw ? Number.parseInt(pollMsRaw, 10) : 1500;
	if (Number.isNaN(pollMs) || pollMs < 250) {
		throw new ValidationError("--poll-ms must be an integer >= 250", {
			field: "poll-ms",
			value: pollMsRaw,
		});
	}

	const sep = args.indexOf("--");
	const forwarded = sep === -1 ? args.filter((a) => !a.startsWith("--")) : args.slice(sep + 1);
	const codexArgs = [...forwarded];
	if (!codexArgs.some((a) => a === "--cd" || a === "-C")) {
		codexArgs.push("--cd", projectRoot);
	}

	const sessionDir = join(
		projectRoot,
		".codexstory",
		"logs",
		agent,
		new Date().toISOString().replaceAll(":", "-"),
	);
	await mkdir(sessionDir, { recursive: true });
	const sessionLogPath = join(sessionDir, "session-events.jsonl");

	const proc = Bun.spawn(["codex", ...codexArgs], {
		cwd: projectRoot,
		stdio: ["inherit", "inherit", "inherit"],
		env: {
			...process.env,
			CODEX_TUI_RECORD_SESSION: "1",
			CODEX_TUI_SESSION_LOG_PATH: sessionLogPath,
		},
	});

	let offset = 0;
	let checking = false;
	const cliEntry = join(import.meta.dir, "..", "index.ts");
	const pollTimer = setInterval(async () => {
		if (checking) return;
		checking = true;
		try {
			const file = Bun.file(sessionLogPath);
			if (!(await file.exists())) return;
			const stat = await file.stat();
			if (stat.size <= offset) return;
			offset = stat.size;

			// Trigger a lightweight background mail check whenever new session events arrive.
			// This approximates hook-driven mailbox polling when Codex lifecycle hooks are unavailable.
			const checker = Bun.spawn(
				[process.argv[0] ?? "bun", cliEntry, "mail", "check", "--agent", agent, "--json"],
				{
					cwd: projectRoot,
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			await checker.exited;
		} catch {
			// Sidecar failures are non-fatal.
		} finally {
			checking = false;
		}
	}, pollMs);

	try {
		const exit = await proc.exited;
		process.exitCode = exit;
	} finally {
		clearInterval(pollTimer);
	}
}

export async function hooksCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${HOOKS_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "install":
			await installHooks(subArgs);
			break;
		case "uninstall":
			await uninstallHooks(subArgs);
			break;
		case "status":
			await statusHooks(subArgs);
			break;
		case "run":
			await runHooks(subArgs);
			break;
		default:
			throw new ValidationError(
				`Unknown hooks subcommand: ${subcommand}. Run 'codexstory hooks --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
