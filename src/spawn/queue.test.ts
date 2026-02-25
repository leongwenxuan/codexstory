import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpawnQueueStore } from "./queue.ts";

describe("createSpawnQueueStore", () => {
	let tempDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "codexstory-spawn-queue-test-"));
		dbPath = join(tempDir, "sessions.db");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("enqueue reuses existing request for same idempotency key", () => {
		const store = createSpawnQueueStore(dbPath);
		try {
			const first = store.enqueue({
				idempotencyKey: "idem-1",
				runId: "run-1",
				taskId: "beads-1",
				agentName: "builder-1",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-1", "--name", "builder-1"],
				maxAttempts: 2,
			});
			const second = store.enqueue({
				idempotencyKey: "idem-1",
				runId: "run-1",
				taskId: "beads-1",
				agentName: "builder-1",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-1", "--name", "builder-1"],
				maxAttempts: 2,
			});

			expect(first.reused).toBe(false);
			expect(second.reused).toBe(true);
			expect(second.request.id).toBe(first.request.id);
		} finally {
			store.close();
		}
	});

	test("claimNext acquires queued request and marks it running", () => {
		const store = createSpawnQueueStore(dbPath);
		try {
			store.enqueue({
				idempotencyKey: "idem-2",
				runId: "run-1",
				taskId: "beads-2",
				agentName: "builder-2",
				capability: "builder",
				parentAgent: "lead-1",
				depth: 1,
				args: ["beads-2", "--name", "builder-2"],
				maxAttempts: 2,
			});

			const claimed = store.claimNext("worker-a", 5000);
			expect(claimed).not.toBeNull();
			expect(claimed?.status).toBe("running");
			expect(claimed?.leaseOwner).toBe("worker-a");
			expect(claimed?.attemptCount).toBe(1);
		} finally {
			store.close();
		}
	});

	test("completeSuccess and completeFailure set terminal states", () => {
		const store = createSpawnQueueStore(dbPath);
		try {
			const successReq = store.enqueue({
				idempotencyKey: "idem-3",
				runId: "run-1",
				taskId: "beads-3",
				agentName: "builder-3",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-3", "--name", "builder-3"],
				maxAttempts: 2,
			});
			const failedReq = store.enqueue({
				idempotencyKey: "idem-4",
				runId: "run-1",
				taskId: "beads-4",
				agentName: "builder-4",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-4", "--name", "builder-4"],
				maxAttempts: 2,
			});

			store.acquireById(successReq.request.id, "worker-a", 5000);
			store.acquireById(failedReq.request.id, "worker-b", 5000);

			store.completeSuccess(successReq.request.id, "worker-a", '{"ok":true}');
			store.completeFailure(failedReq.request.id, "worker-b", "boom");

			const success = store.getById(successReq.request.id);
			const failed = store.getById(failedReq.request.id);
			expect(success?.status).toBe("succeeded");
			expect(success?.resultJson).toBe('{"ok":true}');
			expect(failed?.status).toBe("dead_letter");
			expect(failed?.errorText).toBe("boom");
		} finally {
			store.close();
		}
	});

	test("completion is fenced by lease owner", () => {
		const store = createSpawnQueueStore(dbPath);
		try {
			const req = store.enqueue({
				idempotencyKey: "idem-5",
				runId: "run-1",
				taskId: "beads-5",
				agentName: "builder-5",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-5", "--name", "builder-5"],
				maxAttempts: 2,
			});
			store.acquireById(req.request.id, "worker-a", 5000);

			const okWrong = store.completeSuccess(req.request.id, "worker-b", '{"ok":true}');
			expect(okWrong).toBe(false);
			const stillRunning = store.getById(req.request.id);
			expect(stillRunning?.status).toBe("running");

			const okRight = store.completeSuccess(req.request.id, "worker-a", '{"ok":true}');
			expect(okRight).toBe(true);
			const done = store.getById(req.request.id);
			expect(done?.status).toBe("succeeded");
		} finally {
			store.close();
		}
	});

	test("retryable failure requeues then dead-letters on later failure", () => {
		const store = createSpawnQueueStore(dbPath);
		try {
			const req = store.enqueue({
				idempotencyKey: "idem-6",
				runId: "run-1",
				taskId: "beads-6",
				agentName: "builder-6",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-6", "--name", "builder-6"],
				maxAttempts: 2,
			});
			store.acquireById(req.request.id, "worker-a", 5000);
			const first = store.completeFailure(req.request.id, "worker-a", "transient", {
				retryable: true,
				errorCode: "transient",
				backoffMs: 250,
			});
			expect(first).toBe(true);
			const requeued = store.getById(req.request.id);
			expect(requeued?.status).toBe("queued");
			expect(requeued?.lastErrorCode).toBe("transient");
			expect(typeof requeued?.nextAttemptAt).toBe("string");

			store.acquireById(req.request.id, "worker-a", 5000);
			const second = store.completeFailure(req.request.id, "worker-a", "fatal");
			expect(second).toBe(true);
			const dead = store.getById(req.request.id);
			expect(dead?.status).toBe("dead_letter");
			expect(dead?.errorText).toBe("fatal");
		} finally {
			store.close();
		}
	});

	test("replayDeadLetter resets request for reprocessing", () => {
		const store = createSpawnQueueStore(dbPath);
		try {
			const req = store.enqueue({
				idempotencyKey: "idem-7",
				runId: "run-1",
				taskId: "beads-7",
				agentName: "builder-7",
				capability: "builder",
				parentAgent: null,
				depth: 0,
				args: ["beads-7", "--name", "builder-7"],
				maxAttempts: 1,
			});
			store.acquireById(req.request.id, "worker-a", 5000);
			store.completeFailure(req.request.id, "worker-a", "boom");

			const replayed = store.replayDeadLetter(req.request.id);
			expect(replayed).toBe(true);

			const reset = store.getById(req.request.id);
			expect(reset?.status).toBe("queued");
			expect(reset?.attemptCount).toBe(0);
			expect(reset?.errorText).toBeNull();
		} finally {
			store.close();
		}
	});
});
