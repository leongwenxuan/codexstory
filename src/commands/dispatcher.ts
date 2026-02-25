import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { createSpawnQueueStore } from "../spawn/queue.ts";
import { processQueuedSpawnRequestById } from "./sling.ts";

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

async function readPidFile(path: string): Promise<number | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		const pid = Number.parseInt((await file.text()).trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) return null;
		return pid;
	} catch {
		return null;
	}
}

async function removePidFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// best effort
	}
}

async function resolveCodexstoryBin(): Promise<string> {
	try {
		const proc = Bun.spawn(["which", "codexstory"], { stdout: "pipe", stderr: "pipe" });
		if ((await proc.exited) === 0) {
			const bin = (await new Response(proc.stdout).text()).trim();
			if (bin.length > 0) return bin;
		}
	} catch {
		// fallback below
	}
	const scriptPath = process.argv[1];
	if (!scriptPath) {
		throw new AgentError("Unable to resolve codexstory binary path", { agentName: "dispatcher" });
	}
	return scriptPath;
}

async function runOnce(args: string[]): Promise<void> {
	const requestId = getFlag(args, "--request");
	if (!requestId) {
		throw new ValidationError("--request <id> is required", { field: "request" });
	}
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	await processQueuedSpawnRequestById(
		config.project.root,
		requestId,
		"dispatcher-run-once",
		config.dispatch.claimLeaseMs,
	);
}

async function runLoop(args: string[]): Promise<void> {
	const intervalStr = getFlag(args, "--interval");
	const workersStr = getFlag(args, "--workers");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const intervalMs = intervalStr
		? Number.parseInt(intervalStr, 10)
		: config.dispatch.pollIntervalMs;
	const maxWorkers = workersStr ? Number.parseInt(workersStr, 10) : config.dispatch.maxWorkers;

	if (Number.isNaN(intervalMs) || intervalMs < 200) {
		throw new ValidationError("--interval must be a number >= 200", {
			field: "interval",
			value: intervalStr,
		});
	}
	if (Number.isNaN(maxWorkers) || maxWorkers < 1) {
		throw new ValidationError("--workers must be a number >= 1", {
			field: "workers",
			value: workersStr,
		});
	}
	const dbPath = join(config.project.root, ".codexstory", "sessions.db");
	const store = createSpawnQueueStore(dbPath);
	const owner = `dispatcher-${process.pid}`;
	const inFlight = new Set<Promise<void>>();

	try {
		while (true) {
			while (inFlight.size < maxWorkers) {
				const next = store.claimNext(owner, config.dispatch.claimLeaseMs);
				if (!next) {
					break;
				}
				const job = processQueuedSpawnRequestById(
					config.project.root,
					next.id,
					owner,
					config.dispatch.claimLeaseMs,
				)
					.catch((err) => {
						const message = err instanceof Error ? err.message : String(err);
						process.stderr.write(`dispatcher: request ${next.id} failed: ${message}\n`);
					})
					.finally(() => {
						inFlight.delete(job);
					});
				inFlight.add(job);
			}
			if (inFlight.size === 0) {
				await Bun.sleep(intervalMs);
				continue;
			}
			await Promise.race(inFlight);
		}
	} finally {
		store.close();
	}
}

async function startDispatcher(args: string[]): Promise<void> {
	const background = args.includes("--background");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const pidPath = join(config.project.root, ".codexstory", "dispatcher.pid");

	if (background) {
		const existingPid = await readPidFile(pidPath);
		if (existingPid !== null) {
			try {
				process.kill(existingPid, 0);
				throw new AgentError(`Dispatcher already running (PID ${existingPid})`, {
					agentName: "dispatcher",
				});
			} catch {
				await removePidFile(pidPath);
			}
		}

		const bin = await resolveCodexstoryBin();
		const childArgs = ["dispatcher", "start", ...args.filter((a) => a !== "--background")];
		const child = Bun.spawn(["bun", "run", bin, ...childArgs], {
			cwd,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		await Bun.write(pidPath, `${child.pid}\n`);
		process.stdout.write(`Dispatcher started in background (PID: ${child.pid})\n`);
		return;
	}

	await Bun.write(pidPath, `${process.pid}\n`);
	process.on("SIGINT", () => {
		removePidFile(pidPath).finally(() => process.exit(0));
	});
	process.on("SIGTERM", () => {
		removePidFile(pidPath).finally(() => process.exit(0));
	});
	try {
		await runLoop(args);
	} finally {
		await removePidFile(pidPath);
	}
}

async function stopDispatcher(): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const pidPath = join(config.project.root, ".codexstory", "dispatcher.pid");
	const pid = await readPidFile(pidPath);
	if (pid === null) {
		process.stdout.write("Dispatcher is not running\n");
		return;
	}
	try {
		process.kill(pid, 15);
	} catch {
		// process may already be gone
	}
	await removePidFile(pidPath);
	process.stdout.write(`Dispatcher stopped (PID: ${pid})\n`);
}

async function statusDispatcher(): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const pidPath = join(config.project.root, ".codexstory", "dispatcher.pid");
	const pid = await readPidFile(pidPath);
	if (pid === null) {
		process.stdout.write("Dispatcher: not running\n");
		return;
	}
	try {
		process.kill(pid, 0);
		process.stdout.write(`Dispatcher: running (PID ${pid})\n`);
	} catch {
		process.stdout.write("Dispatcher: stale pid file (cleaning up)\n");
		await removePidFile(pidPath);
	}
}

async function listDeadLetter(args: string[]): Promise<void> {
	const limitStr = getFlag(args, "--limit");
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 50;
	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a number >= 1", {
			field: "limit",
			value: limitStr,
		});
	}
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const dbPath = join(config.project.root, ".codexstory", "sessions.db");
	if (!(await Bun.file(dbPath).exists())) {
		process.stdout.write(`${JSON.stringify({ count: 0, items: [] })}\n`);
		return;
	}
	const store = createSpawnQueueStore(dbPath);
	try {
		const dead = store
			.list("dead_letter")
			.slice(0, limit)
			.map((r) => ({
				id: r.id,
				agentName: r.agentName,
				taskId: r.taskId,
				attemptCount: r.attemptCount,
				maxAttempts: r.maxAttempts,
				lastErrorCode: r.lastErrorCode,
				errorText: r.errorText,
				completedAt: r.completedAt,
			}));
		process.stdout.write(`${JSON.stringify({ count: dead.length, items: dead })}\n`);
	} finally {
		store.close();
	}
}

async function replayDeadLetter(args: string[]): Promise<void> {
	const requestId = getFlag(args, "--request");
	if (!requestId) {
		throw new ValidationError("--request <id> is required", { field: "request" });
	}
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const dbPath = join(config.project.root, ".codexstory", "sessions.db");
	if (!(await Bun.file(dbPath).exists())) {
		throw new ValidationError(
			`Spawn queue database not found. Start by creating spawn requests with 'codexstory sling ...'`,
			{
				field: "request",
				value: requestId,
			},
		);
	}
	const store = createSpawnQueueStore(dbPath);
	try {
		const ok = store.replayDeadLetter(requestId);
		if (!ok) {
			throw new ValidationError(`Dead-letter request not found: ${requestId}`, {
				field: "request",
				value: requestId,
			});
		}
		process.stdout.write(`${JSON.stringify({ requestId, replayed: true })}\n`);
	} finally {
		store.close();
	}
}

const DISPATCHER_HELP = `codexstory dispatcher — Manage spawn request dispatcher

Usage: codexstory dispatcher <subcommand> [options]

Subcommands:
  start [--background] [--interval <ms>] [--workers <n>]  Start dispatcher loop
  stop                                     Stop background dispatcher
  status                                   Show dispatcher status
  run-once --request <id>                  Process a single queued request by ID
  dlq list [--limit <n>]                   List dead-letter spawn requests
  dlq replay --request <id>                Replay one dead-letter request

Options:
  --help, -h                               Show this help`;

export async function dispatcherCommand(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${DISPATCHER_HELP}\n`);
		return;
	}
	const sub = args[0];
	const subArgs = args.slice(1);
	switch (sub) {
		case "start":
			await startDispatcher(subArgs);
			break;
		case "stop":
			await stopDispatcher();
			break;
		case "status":
			await statusDispatcher();
			break;
		case "run-once":
			await runOnce(subArgs);
			break;
		case "dlq": {
			const action = subArgs[0];
			const actionArgs = subArgs.slice(1);
			if (action === "list") {
				await listDeadLetter(actionArgs);
				break;
			}
			if (action === "replay") {
				await replayDeadLetter(actionArgs);
				break;
			}
			throw new ValidationError(`Unknown dispatcher dlq action: ${action ?? "<missing>"}`, {
				field: "action",
				value: action,
			});
		}
		default:
			throw new ValidationError(`Unknown dispatcher subcommand: ${sub}`, {
				field: "subcommand",
				value: sub,
			});
	}
}
