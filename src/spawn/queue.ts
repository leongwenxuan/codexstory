import { Database } from "bun:sqlite";

export type SpawnRequestStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter";

export interface SpawnRequest {
	id: string;
	idempotencyKey: string;
	runId: string;
	taskId: string;
	agentName: string;
	capability: string;
	parentAgent: string | null;
	depth: number;
	args: string[];
	status: SpawnRequestStatus;
	attemptCount: number;
	maxAttempts: number;
	leaseOwner: string | null;
	leaseExpiresAt: string | null;
	nextAttemptAt: string;
	lastErrorCode: string | null;
	resultJson: string | null;
	errorText: string | null;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	completedAt: string | null;
}

interface SpawnRequestRow {
	id: string;
	idempotency_key: string;
	run_id: string;
	task_id: string;
	agent_name: string;
	capability: string;
	parent_agent: string | null;
	depth: number;
	args_json: string;
	status: string;
	attempt_count: number;
	max_attempts: number;
	lease_owner: string | null;
	lease_expires_at: string | null;
	next_attempt_at: string;
	last_error_code: string | null;
	result_json: string | null;
	error_text: string | null;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	completed_at: string | null;
}

export interface CreateSpawnRequestInput {
	idempotencyKey: string;
	runId: string;
	taskId: string;
	agentName: string;
	capability: string;
	parentAgent: string | null;
	depth: number;
	args: string[];
	maxAttempts?: number;
}

export interface SpawnQueueStore {
	enqueue(input: CreateSpawnRequestInput): { request: SpawnRequest; reused: boolean };
	getById(id: string): SpawnRequest | null;
	getByIdempotencyKey(key: string): SpawnRequest | null;
	acquireById(id: string, owner: string, leaseMs: number): SpawnRequest | null;
	claimNext(owner: string, leaseMs: number): SpawnRequest | null;
	heartbeat(id: string, owner: string, leaseMs: number): boolean;
	completeSuccess(id: string, owner: string, resultJson: string): boolean;
	completeFailure(
		id: string,
		owner: string,
		errorText: string,
		opts?: { retryable?: boolean; errorCode?: string | null; backoffMs?: number },
	): boolean;
	replayDeadLetter(id: string): boolean;
	list(status?: SpawnRequestStatus): SpawnRequest[];
	close(): void;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS spawn_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  capability TEXT NOT NULL,
  parent_agent TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','succeeded','failed','dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  last_error_code TEXT,
  result_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  started_at TEXT,
  completed_at TEXT
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_spawn_requests_status_created ON spawn_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_spawn_requests_lease ON spawn_requests(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_spawn_requests_agent ON spawn_requests(agent_name, status)`;

function rowToSpawnRequest(row: SpawnRequestRow): SpawnRequest {
	let args: string[] = [];
	try {
		const parsed = JSON.parse(row.args_json) as unknown;
		args = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
	} catch {
		args = [];
	}
	return {
		id: row.id,
		idempotencyKey: row.idempotency_key,
		runId: row.run_id,
		taskId: row.task_id,
		agentName: row.agent_name,
		capability: row.capability,
		parentAgent: row.parent_agent,
		depth: row.depth,
		args,
		status: row.status as SpawnRequestStatus,
		attemptCount: row.attempt_count,
		maxAttempts: row.max_attempts,
		leaseOwner: row.lease_owner,
		leaseExpiresAt: row.lease_expires_at,
		nextAttemptAt: row.next_attempt_at,
		lastErrorCode: row.last_error_code,
		resultJson: row.result_json,
		errorText: row.error_text,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

function buildExpiry(leaseMs: number): string {
	return new Date(Date.now() + leaseMs).toISOString();
}

export function createSpawnQueueStore(dbPath: string): SpawnQueueStore {
	const db = new Database(dbPath);

	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);
	// Forward-compatible migrations for existing databases.
	try {
		db.exec(
			"ALTER TABLE spawn_requests ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))",
		);
	} catch {
		// Column likely already exists.
	}
	try {
		db.exec("ALTER TABLE spawn_requests ADD COLUMN last_error_code TEXT");
	} catch {
		// Column likely already exists.
	}

	const insertStmt = db.prepare<
		void,
		{
			$id: string;
			$idempotency_key: string;
			$run_id: string;
			$task_id: string;
			$agent_name: string;
			$capability: string;
			$parent_agent: string | null;
			$depth: number;
			$args_json: string;
			$max_attempts: number;
		}
	>(`
		INSERT OR IGNORE INTO spawn_requests
		(id, idempotency_key, run_id, task_id, agent_name, capability, parent_agent, depth, args_json, max_attempts)
		VALUES
		($id, $idempotency_key, $run_id, $task_id, $agent_name, $capability, $parent_agent, $depth, $args_json, $max_attempts)
	`);

	const getByIdStmt = db.prepare<SpawnRequestRow, { $id: string }>(
		"SELECT * FROM spawn_requests WHERE id = $id",
	);
	const getByKeyStmt = db.prepare<SpawnRequestRow, { $idempotency_key: string }>(
		"SELECT * FROM spawn_requests WHERE idempotency_key = $idempotency_key",
	);
	const listAllStmt = db.prepare<SpawnRequestRow, []>(
		"SELECT * FROM spawn_requests ORDER BY created_at ASC",
	);
	const listByStatusStmt = db.prepare<SpawnRequestRow, { $status: string }>(
		"SELECT * FROM spawn_requests WHERE status = $status ORDER BY created_at ASC",
	);

	const acquireByIdStmt = db.prepare<
		void,
		{ $id: string; $owner: string; $lease_expires_at: string; $now: string }
	>(`
		UPDATE spawn_requests
		SET status = 'running',
			attempt_count = attempt_count + 1,
			lease_owner = $owner,
			lease_expires_at = $lease_expires_at,
			started_at = COALESCE(started_at, $now),
			updated_at = $now
		WHERE id = $id
		  AND (
			status = 'queued'
			OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < $now)
		  )
	`);

	const claimNextSelectStmt = db.prepare<SpawnRequestRow, { $now: string }>(`
		SELECT * FROM spawn_requests
		WHERE (
			(status = 'queued' AND next_attempt_at <= $now)
			OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < $now)
		)
		AND attempt_count < max_attempts
		ORDER BY created_at ASC
		LIMIT 1
	`);

	const heartbeatStmt = db.prepare<
		void,
		{ $id: string; $owner: string; $lease_expires_at: string; $now: string }
	>(`
		UPDATE spawn_requests
		SET lease_expires_at = $lease_expires_at,
			updated_at = $now
		WHERE id = $id AND status = 'running' AND lease_owner = $owner
	`);

	const completeSuccessStmt = db.prepare<
		void,
		{ $id: string; $owner: string; $result_json: string; $now: string }
	>(`
		UPDATE spawn_requests
		SET status = 'succeeded',
			result_json = $result_json,
			error_text = NULL,
			last_error_code = NULL,
			lease_owner = NULL,
			lease_expires_at = NULL,
			completed_at = $now,
			updated_at = $now
		WHERE id = $id AND status = 'running' AND lease_owner = $owner
	`);

	const completeFailureDeadLetterStmt = db.prepare<
		void,
		{ $id: string; $owner: string; $error_text: string; $error_code: string | null; $now: string }
	>(`
		UPDATE spawn_requests
		SET status = 'dead_letter',
			error_text = $error_text,
			last_error_code = $error_code,
			lease_owner = NULL,
			lease_expires_at = NULL,
			completed_at = $now,
			updated_at = $now
		WHERE id = $id AND status = 'running' AND lease_owner = $owner
	`);

	const completeFailureRetryStmt = db.prepare<
		void,
		{
			$id: string;
			$owner: string;
			$error_text: string;
			$error_code: string | null;
			$next_attempt_at: string;
			$now: string;
		}
	>(`
		UPDATE spawn_requests
		SET status = 'queued',
			error_text = $error_text,
			last_error_code = $error_code,
			lease_owner = NULL,
			lease_expires_at = NULL,
			next_attempt_at = $next_attempt_at,
			updated_at = $now
		WHERE id = $id AND status = 'running' AND lease_owner = $owner AND attempt_count < max_attempts
	`);

	const replayDeadLetterStmt = db.prepare<void, { $id: string; $now: string }>(`
		UPDATE spawn_requests
		SET status = 'queued',
			attempt_count = 0,
			lease_owner = NULL,
			lease_expires_at = NULL,
			next_attempt_at = $now,
			last_error_code = NULL,
			error_text = NULL,
			started_at = NULL,
			completed_at = NULL,
			updated_at = $now
		WHERE id = $id AND status = 'dead_letter'
	`);

	return {
		enqueue(input): { request: SpawnRequest; reused: boolean } {
			const existing = getByKeyStmt.get({ $idempotency_key: input.idempotencyKey });
			if (existing) {
				return { request: rowToSpawnRequest(existing), reused: true };
			}

			const id = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
			insertStmt.run({
				$id: id,
				$idempotency_key: input.idempotencyKey,
				$run_id: input.runId,
				$task_id: input.taskId,
				$agent_name: input.agentName,
				$capability: input.capability,
				$parent_agent: input.parentAgent,
				$depth: input.depth,
				$args_json: JSON.stringify(input.args),
				$max_attempts: input.maxAttempts ?? 1,
			});

			const inserted = getByIdStmt.get({ $id: id });
			if (!inserted) {
				const race = getByKeyStmt.get({ $idempotency_key: input.idempotencyKey });
				if (race) {
					return { request: rowToSpawnRequest(race), reused: true };
				}
				throw new Error("Failed to enqueue spawn request");
			}

			return { request: rowToSpawnRequest(inserted), reused: false };
		},

		getById(id: string): SpawnRequest | null {
			const row = getByIdStmt.get({ $id: id });
			return row ? rowToSpawnRequest(row) : null;
		},

		getByIdempotencyKey(key: string): SpawnRequest | null {
			const row = getByKeyStmt.get({ $idempotency_key: key });
			return row ? rowToSpawnRequest(row) : null;
		},

		acquireById(id: string, owner: string, leaseMs: number): SpawnRequest | null {
			const now = nowIso();
			const leaseExpiresAt = buildExpiry(leaseMs);
			acquireByIdStmt.run({
				$id: id,
				$owner: owner,
				$lease_expires_at: leaseExpiresAt,
				$now: now,
			});
			const row = getByIdStmt.get({ $id: id });
			if (!row) return null;
			if (row.status !== "running" || row.lease_owner !== owner) {
				return null;
			}
			return rowToSpawnRequest(row);
		},

		claimNext(owner: string, leaseMs: number): SpawnRequest | null {
			const now = nowIso();
			const row = claimNextSelectStmt.get({ $now: now });
			if (!row) return null;
			return this.acquireById(row.id, owner, leaseMs);
		},

		heartbeat(id: string, owner: string, leaseMs: number): boolean {
			const now = nowIso();
			heartbeatStmt.run({
				$id: id,
				$owner: owner,
				$lease_expires_at: buildExpiry(leaseMs),
				$now: now,
			});
			const row = getByIdStmt.get({ $id: id });
			return !!row && row.status === "running" && row.lease_owner === owner;
		},

		completeSuccess(id: string, owner: string, resultJson: string): boolean {
			const now = nowIso();
			const result = completeSuccessStmt.run({
				$id: id,
				$owner: owner,
				$result_json: resultJson,
				$now: now,
			});
			return result.changes > 0;
		},

		completeFailure(
			id: string,
			owner: string,
			errorText: string,
			opts?: { retryable?: boolean; errorCode?: string | null; backoffMs?: number },
		): boolean {
			const now = nowIso();
			const retryable = opts?.retryable ?? false;
			const errorCode = opts?.errorCode ?? null;
			if (retryable) {
				const backoffMs = Math.max(200, opts?.backoffMs ?? 1_000);
				const retried = completeFailureRetryStmt.run({
					$id: id,
					$owner: owner,
					$error_text: errorText,
					$error_code: errorCode,
					$next_attempt_at: buildExpiry(backoffMs),
					$now: now,
				});
				if (retried.changes > 0) return true;
			}
			const deadLettered = completeFailureDeadLetterStmt.run({
				$id: id,
				$owner: owner,
				$error_text: errorText,
				$error_code: errorCode,
				$now: now,
			});
			return deadLettered.changes > 0;
		},

		replayDeadLetter(id: string): boolean {
			const now = nowIso();
			const result = replayDeadLetterStmt.run({ $id: id, $now: now });
			return result.changes > 0;
		},

		list(status?: SpawnRequestStatus): SpawnRequest[] {
			const rows = status
				? listByStatusStmt.all({ $status: status })
				: listAllStmt.all();
			return rows.map(rowToSpawnRequest);
		},

		close(): void {
			db.close();
		},
	};
}
