import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createSpawnQueueStore } from "../spawn/queue.ts";
import { dispatcherCommand } from "./dispatcher.ts";

describe("dispatcherCommand", () => {
	let tempDir: string;
	let overstoryDir: string;
	let originalCwd: string;
	let originalStdoutWrite: typeof process.stdout.write;
	let stdoutChunks: string[];

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "dispatcher-test-"));
		overstoryDir = join(tempDir, ".codexstory");
		await mkdir(overstoryDir, { recursive: true });

		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test-project\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		originalCwd = process.cwd();
		process.chdir(tempDir);

		stdoutChunks = [];
		originalStdoutWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.stdout.write = originalStdoutWrite;
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	function stdout(): string {
		return stdoutChunks.join("");
	}

	test("shows help when no args provided", async () => {
		await dispatcherCommand([]);
		expect(stdout()).toContain("codexstory dispatcher");
		expect(stdout()).toContain("run-once --request <id>");
	});

	test("run-once requires --request", async () => {
		await expect(dispatcherCommand(["run-once"])).rejects.toBeInstanceOf(ValidationError);
	});

	test("unknown subcommand throws validation error", async () => {
		await expect(dispatcherCommand(["wat"])).rejects.toBeInstanceOf(ValidationError);
	});

	test("status reports not running when no pid file", async () => {
		await dispatcherCommand(["status"]);
		expect(stdout()).toContain("Dispatcher: not running");
	});

	test("status cleans stale pid file", async () => {
		const pidPath = join(overstoryDir, "dispatcher.pid");
		await Bun.write(pidPath, "999999\n");

		await dispatcherCommand(["status"]);
		expect(stdout()).toContain("stale pid file");
		expect(await Bun.file(pidPath).exists()).toBe(false);
	});

	test("status reports running for live pid", async () => {
		const pidPath = join(overstoryDir, "dispatcher.pid");
		await Bun.write(pidPath, `${process.pid}\n`);

		await dispatcherCommand(["status"]);
		expect(stdout()).toContain(`Dispatcher: running (PID ${process.pid})`);
	});

	test("stop reports not running when no pid file", async () => {
		await dispatcherCommand(["stop"]);
		expect(stdout()).toContain("Dispatcher is not running");
	});

	test("start validates --workers and cleans pid file on early failure", async () => {
		const pidPath = join(overstoryDir, "dispatcher.pid");
		await expect(
			dispatcherCommand(["start", "--workers", "0", "--interval", "500"]),
		).rejects.toBeInstanceOf(ValidationError);

		// start() writes pid before entering runLoop; it must always be removed on failure
		expect(await Bun.file(pidPath).exists()).toBe(false);
	});

	test("start validates --interval and removes pid file on failure", async () => {
		const pidPath = join(overstoryDir, "dispatcher.pid");
		await expect(
			dispatcherCommand(["start", "--workers", "1", "--interval", "100"]),
		).rejects.toBeInstanceOf(ValidationError);
		expect(await Bun.file(pidPath).exists()).toBe(false);
	});

	test("stop sends signal to running process pid", async () => {
		const pidPath = join(overstoryDir, "dispatcher.pid");
		// Spawn a short-lived sleep to avoid signaling this test process.
		const proc = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
		await Bun.write(pidPath, `${proc.pid}\n`);

		await dispatcherCommand(["stop"]);
		expect(stdout()).toContain(`Dispatcher stopped (PID: ${proc.pid})`);
		expect(await Bun.file(pidPath).exists()).toBe(false);

		// Ensure process is no longer alive.
		expect(proc.exitCode).not.toBeUndefined();
	});

	test("stop handles malformed pid file as not running", async () => {
		const pidPath = join(overstoryDir, "dispatcher.pid");
		await Bun.write(pidPath, "not-a-pid\n");

		await dispatcherCommand(["stop"]);
		expect(stdout()).toContain("Dispatcher is not running");

		const content = (await readFile(pidPath, "utf8")).trim();
		expect(content).toBe("not-a-pid");
	});

	test("dlq list returns dead-letter items", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSpawnQueueStore(dbPath);
		try {
			const req = store.enqueue({
				idempotencyKey: "idem-dlq-1",
				runId: "run-1",
				taskId: "beads-1",
				agentName: "builder-1",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-1", "--name", "builder-1"],
				maxAttempts: 1,
			});
			store.acquireById(req.request.id, "worker-a", 5000);
			store.completeFailure(req.request.id, "worker-a", "boom", { errorCode: "fatal" });
		} finally {
			store.close();
		}

		await dispatcherCommand(["dlq", "list", "--limit", "10"]);
		const parsed = JSON.parse(stdout()) as { count: number; items: Array<{ errorText: string }> };
		expect(parsed.count).toBe(1);
		expect(parsed.items[0]?.errorText).toBe("boom");
	});

	test("dlq replay moves dead-letter request back to queue", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSpawnQueueStore(dbPath);
		let requestId = "";
		try {
			const req = store.enqueue({
				idempotencyKey: "idem-dlq-2",
				runId: "run-1",
				taskId: "beads-2",
				agentName: "builder-2",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-2", "--name", "builder-2"],
				maxAttempts: 1,
			});
			requestId = req.request.id;
			store.acquireById(requestId, "worker-a", 5000);
			store.completeFailure(requestId, "worker-a", "boom");
		} finally {
			store.close();
		}

		await dispatcherCommand(["dlq", "replay", "--request", requestId]);
		const replayResult = JSON.parse(stdout()) as { replayed: boolean; requestId: string };
		expect(replayResult.replayed).toBe(true);
		expect(replayResult.requestId).toBe(requestId);

		const recheck = createSpawnQueueStore(dbPath);
		try {
			const request = recheck.getById(requestId);
			expect(request?.status).toBe("queued");
			expect(request?.attemptCount).toBe(0);
		} finally {
			recheck.close();
		}
	});
});
