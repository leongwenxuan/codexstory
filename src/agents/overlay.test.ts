import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import type { OverlayConfig, QualityGate } from "../types.ts";
import { generateOverlay, isCanonicalRoot, writeOverlay } from "./overlay.ts";

const SAMPLE_BASE_DEFINITION = `# Builder Agent

You are a **builder agent** in the codexstory swarm system.

## Role
Implement changes according to a spec.

## Propulsion Principle
Read your assignment. Execute immediately.

## Failure Modes
- FILE_SCOPE_VIOLATION
- SILENT_FAILURE
`;

/** Build a complete OverlayConfig with sensible defaults, overrideable by partial. */
function makeConfig(overrides?: Partial<OverlayConfig>): OverlayConfig {
	return {
		agentName: "test-builder",
		beadId: "codexstory-abc",
		specPath: ".codexstory/specs/codexstory-abc.md",
		branchName: "agent/test-builder/codexstory-abc",
		worktreePath: "/tmp/test-project/.codexstory/worktrees/test-builder",
		fileScope: ["src/agents/manifest.ts", "src/agents/overlay.ts"],
		mulchDomains: ["typescript", "testing"],
		parentAgent: "lead-alpha",
		depth: 1,
		canSpawn: false,
		capability: "builder",
		baseDefinition: SAMPLE_BASE_DEFINITION,
		...overrides,
	};
}

describe("generateOverlay", () => {
	test("output contains agent name", async () => {
		const config = makeConfig({ agentName: "my-scout" });
		const output = await generateOverlay(config);

		expect(output).toContain("my-scout");
	});

	test("output contains bead ID", async () => {
		const config = makeConfig({ beadId: "codexstory-xyz" });
		const output = await generateOverlay(config);

		expect(output).toContain("codexstory-xyz");
	});

	test("output contains branch name", async () => {
		const config = makeConfig({ branchName: "agent/scout/codexstory-xyz" });
		const output = await generateOverlay(config);

		expect(output).toContain("agent/scout/codexstory-xyz");
	});

	test("output contains parent agent name", async () => {
		const config = makeConfig({ parentAgent: "lead-bravo" });
		const output = await generateOverlay(config);

		expect(output).toContain("lead-bravo");
	});

	test("output contains depth", async () => {
		const config = makeConfig({ depth: 2 });
		const output = await generateOverlay(config);

		expect(output).toContain("2");
	});

	test("output contains spec path when provided", async () => {
		const config = makeConfig({ specPath: ".codexstory/specs/my-task.md" });
		const output = await generateOverlay(config);

		expect(output).toContain(".codexstory/specs/my-task.md");
	});

	test("shows fallback text when specPath is null", async () => {
		const config = makeConfig({ specPath: null });
		const output = await generateOverlay(config);

		expect(output).toContain("No spec file provided");
		expect(output).not.toContain("{{SPEC_PATH}}");
	});

	test("includes 'Read your task spec' instruction when spec provided", async () => {
		const config = makeConfig({ specPath: ".codexstory/specs/my-task.md" });
		const output = await generateOverlay(config);

		expect(output).toContain("Read your task spec at the path above");
	});

	test("does not include 'Read your task spec' instruction when specPath is null", async () => {
		const config = makeConfig({ specPath: null });
		const output = await generateOverlay(config);

		expect(output).not.toContain("Read your task spec at the path above");
		expect(output).toContain("No task spec was provided");
	});

	test("shows 'coordinator' when parentAgent is null", async () => {
		const config = makeConfig({ parentAgent: null });
		const output = await generateOverlay(config);

		expect(output).toContain("coordinator");
	});

	test("file scope is formatted as markdown bullets", async () => {
		const config = makeConfig({
			fileScope: ["src/foo.ts", "src/bar.ts"],
		});
		const output = await generateOverlay(config);

		expect(output).toContain("- `src/foo.ts`");
		expect(output).toContain("- `src/bar.ts`");
	});

	test("empty file scope shows fallback text", async () => {
		const config = makeConfig({ fileScope: [] });
		const output = await generateOverlay(config);

		expect(output).toContain("No file scope restrictions");
	});

	test("mulch domains formatted as prime command", async () => {
		const config = makeConfig({ mulchDomains: ["typescript", "testing"] });
		const output = await generateOverlay(config);

		expect(output).toContain("mulch prime typescript testing");
	});

	test("empty mulch domains shows fallback text", async () => {
		const config = makeConfig({ mulchDomains: [] });
		const output = await generateOverlay(config);

		expect(output).toContain("No specific expertise domains configured");
	});

	test("canSpawn false says 'You may NOT spawn sub-workers'", async () => {
		const config = makeConfig({ canSpawn: false });
		const output = await generateOverlay(config);

		expect(output).toContain("You may NOT spawn sub-workers");
	});

	test("canSpawn true includes sling example", async () => {
		const config = makeConfig({
			canSpawn: true,
			agentName: "lead-alpha",
			depth: 1,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("codexstory sling");
		expect(output).toContain("--parent lead-alpha");
		expect(output).toContain("--depth 2");
	});

	test("no unreplaced placeholders remain in output", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{");
		expect(output).not.toContain("}}");
	});

	test("includes pre-loaded expertise when mulchExpertise is provided", async () => {
		const config = makeConfig({
			mulchExpertise: "## architecture\n- Pattern: use singleton for config loader",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("### Pre-loaded Expertise");
		expect(output).toContain("automatically loaded at spawn time");
		expect(output).toContain("## architecture");
		expect(output).toContain("Pattern: use singleton for config loader");
	});

	test("omits expertise section when mulchExpertise is undefined", async () => {
		const config = makeConfig({ mulchExpertise: undefined });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
		expect(output).not.toContain("automatically loaded at spawn time");
	});

	test("omits expertise section when mulchExpertise is empty string", async () => {
		const config = makeConfig({ mulchExpertise: "" });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
	});

	test("omits expertise section when mulchExpertise is whitespace only", async () => {
		const config = makeConfig({ mulchExpertise: "   \n\t  \n  " });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
	});

	test("builder capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "builder" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
		expect(output).toContain("Commit");
	});

	test("lead capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "lead" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
	});

	test("merger capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "merger" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
	});

	test("scout capability gets read-only completion section instead of quality gates", async () => {
		const config = makeConfig({ capability: "scout", agentName: "my-scout" });
		const output = await generateOverlay(config);

		expect(output).toContain("Completion");
		expect(output).toContain("read-only agent");
		expect(output).toContain("Do NOT commit");
		expect(output).not.toContain("Quality Gates");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("bun run lint");
	});

	test("reviewer capability gets read-only completion section instead of quality gates", async () => {
		const config = makeConfig({ capability: "reviewer", agentName: "my-reviewer" });
		const output = await generateOverlay(config);

		expect(output).toContain("Completion");
		expect(output).toContain("read-only agent");
		expect(output).toContain("Do NOT commit");
		expect(output).not.toContain("Quality Gates");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("bun run lint");
	});

	test("scout completion section includes bd close and mail send", async () => {
		const config = makeConfig({
			capability: "scout",
			agentName: "recon-1",
			beadId: "codexstory-task1",
			parentAgent: "lead-alpha",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("bd close codexstory-task1");
		expect(output).toContain("codexstory mail send --to lead-alpha");
	});

	test("reviewer completion section uses coordinator when no parent", async () => {
		const config = makeConfig({
			capability: "reviewer",
			parentAgent: null,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("--to coordinator");
	});

	test("output includes communication section with agent address", async () => {
		const config = makeConfig({ agentName: "worker-42" });
		const output = await generateOverlay(config);

		expect(output).toContain("codexstory mail check --agent worker-42");
		expect(output).toContain("codexstory mail send --to");
	});

	test("output includes base agent definition content (Layer 1)", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).toContain("# Builder Agent");
		expect(output).toContain("Propulsion Principle");
		expect(output).toContain("FILE_SCOPE_VIOLATION");
	});

	test("base definition appears before task assignment section", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		const baseDefIndex = output.indexOf("# Builder Agent");
		const assignmentIndex = output.indexOf("## Your Assignment");
		expect(baseDefIndex).toBeGreaterThan(-1);
		expect(assignmentIndex).toBeGreaterThan(-1);
		expect(baseDefIndex).toBeLessThan(assignmentIndex);
	});

	test("output contains worktree path in assignment section", async () => {
		const config = makeConfig({
			worktreePath: "/project/.codexstory/worktrees/my-builder",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("/project/.codexstory/worktrees/my-builder");
		expect(output).toContain("**Worktree:**");
	});

	test("output contains Working Directory section with worktree path", async () => {
		const config = makeConfig({
			worktreePath: "/tmp/worktrees/builder-1",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("## Working Directory");
		expect(output).toContain("Your worktree root is: `/tmp/worktrees/builder-1`");
		expect(output).toContain("PATH_BOUNDARY_VIOLATION");
	});

	test("file scope section references worktree root", async () => {
		const config = makeConfig({
			worktreePath: "/tmp/worktrees/builder-scope",
		});
		const output = await generateOverlay(config);

		expect(output).toContain(
			"These paths are relative to your worktree root: `/tmp/worktrees/builder-scope`",
		);
	});

	test("builder constraints include worktree isolation", async () => {
		const config = makeConfig({
			capability: "builder",
			worktreePath: "/tmp/worktrees/builder-constraints",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("WORKTREE ISOLATION");
		expect(output).toContain("/tmp/worktrees/builder-constraints");
		expect(output).toContain("NEVER write to the canonical repo root");
	});

	test("no unreplaced WORKTREE_PATH placeholders", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{WORKTREE_PATH}}");
	});

	test("builder with custom qualityGates uses them instead of defaults", async () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "pytest", description: "all tests pass" },
			{ name: "Lint", command: "ruff check .", description: "no lint errors" },
		];
		const config = makeConfig({ capability: "builder", qualityGates: gates });
		const output = await generateOverlay(config);

		expect(output).toContain("pytest");
		expect(output).toContain("ruff check .");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("bun run lint");
		expect(output).not.toContain("bun run typecheck");
	});

	test("builder with undefined qualityGates falls back to defaults", async () => {
		const config = makeConfig({ capability: "builder", qualityGates: undefined });
		const output = await generateOverlay(config);

		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
		expect(output).toContain("bun run typecheck");
	});

	test("builder with empty qualityGates array falls back to defaults", async () => {
		const config = makeConfig({ capability: "builder", qualityGates: [] });
		const output = await generateOverlay(config);

		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
		expect(output).toContain("bun run typecheck");
	});

	test("custom qualityGates are numbered correctly", async () => {
		const gates: QualityGate[] = [
			{ name: "Build", command: "cargo build", description: "compilation succeeds" },
			{ name: "Test", command: "cargo test", description: "all tests pass" },
		];
		const config = makeConfig({ capability: "builder", qualityGates: gates });
		const output = await generateOverlay(config);

		expect(output).toContain("1. **Build:**");
		expect(output).toContain("2. **Test:**");
		// Commit should be item 3
		expect(output).toContain("3. **Commit:**");
	});

	test("scout capability ignores qualityGates (stays read-only)", async () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "pytest", description: "all tests pass" },
		];
		const config = makeConfig({ capability: "scout", qualityGates: gates });
		const output = await generateOverlay(config);

		expect(output).toContain("read-only agent");
		expect(output).not.toContain("pytest");
		expect(output).not.toContain("Quality Gates");
	});

	test("default trackerCli renders as bd in quality gates", async () => {
		const config = makeConfig({ capability: "builder", beadId: "codexstory-task1" });
		const output = await generateOverlay(config);

		expect(output).toContain("bd close codexstory-task1");
	});

	test("custom trackerCli replaces bd in quality gates", async () => {
		const config = makeConfig({
			capability: "builder",
			trackerCli: "sd",
			beadId: "codexstory-test1",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("sd close codexstory-test1");
		expect(output).not.toContain("bd close");
	});

	test("custom trackerCli replaces bd in constraints", async () => {
		const config = makeConfig({
			capability: "builder",
			trackerCli: "sd",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("`sd close`");
	});

	test("custom trackerCli replaces bd in read-only completion section", async () => {
		const config = makeConfig({
			capability: "scout",
			trackerCli: "sd",
			beadId: "codexstory-test2",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("sd close codexstory-test2");
		expect(output).not.toContain("bd close");
	});

	test("TRACKER_CLI in base definition is replaced", async () => {
		const config = makeConfig({
			trackerCli: "sd",
			baseDefinition: "Run `{{TRACKER_CLI}} show` to check status.",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Run `sd show` to check status.");
		expect(output).not.toContain("{{TRACKER_CLI}}");
	});

	test("TRACKER_NAME in base definition is replaced", async () => {
		const config = makeConfig({
			trackerName: "seeds",
			baseDefinition: "Close your {{TRACKER_NAME}} issue when done.",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Close your seeds issue when done.");
		expect(output).not.toContain("{{TRACKER_NAME}}");
	});

	test("defaults backward-compatible: no trackerCli/trackerName produces bd/beads", async () => {
		const config = makeConfig({ capability: "builder", beadId: "codexstory-back" });
		const output = await generateOverlay(config);

		expect(output).toContain("bd close codexstory-back");
	});
});

describe("writeOverlay", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "codexstory-overlay-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates CODEXSTORY.md in worktree directory", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();

		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".codex", "CODEXSTORY.md");
		const file = Bun.file(outputPath);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("written file contains the overlay content", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig({ agentName: "file-writer-test" });

		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".codex", "CODEXSTORY.md");
		const content = await Bun.file(outputPath).text();
		expect(content).toContain("file-writer-test");
		expect(content).toContain(config.beadId);
		expect(content).toContain(config.branchName);
	});

	test("creates .codex directory even if worktree already exists", async () => {
		const worktreePath = join(tempDir, "existing-worktree");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(worktreePath, { recursive: true });

		const config = makeConfig();
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".codex", "CODEXSTORY.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("overwrites existing CODEXSTORY.md if it already exists", async () => {
		const worktreePath = join(tempDir, "worktree");
		const claudeDir = join(worktreePath, ".codex");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(join(claudeDir, "CODEXSTORY.md"), "old content");

		const config = makeConfig({ agentName: "new-agent" });
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const content = await Bun.file(join(claudeDir, "CODEXSTORY.md")).text();
		expect(content).toContain("new-agent");
		expect(content).not.toContain("old content");
	});

	test("writeOverlay content matches generateOverlay output", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();

		const generated = await generateOverlay(config);
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const written = await Bun.file(join(worktreePath, ".codex", "CODEXSTORY.md")).text();
		expect(written).toBe(generated);
	});

	test("throws AgentError when worktreePath is the canonical project root", async () => {
		const fakeProjectRoot = join(tempDir, "project-root");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig({ agentName: "rogue-agent" });

		expect(async () => {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
		}).toThrow(AgentError);
	});

	test("error message mentions canonical project root when guard triggers", async () => {
		const fakeProjectRoot = join(tempDir, "project-root-msg");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig({ agentName: "rogue-agent" });

		try {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("canonical project root");
			expect(agentErr.message).toContain(fakeProjectRoot);
			expect(agentErr.agentName).toBe("rogue-agent");
		}
	});

	test("does NOT throw when worktreePath is a proper worktree subdirectory", async () => {
		const fakeProjectRoot = join(tempDir, "project-with-worktrees");
		await mkdir(join(fakeProjectRoot, ".codexstory", "worktrees", "my-agent"), { recursive: true });

		const worktreePath = join(fakeProjectRoot, ".codexstory", "worktrees", "my-agent");
		const config = makeConfig();

		// This should succeed — the worktree is not the canonical root
		await writeOverlay(worktreePath, config, fakeProjectRoot);

		const outputPath = join(worktreePath, ".codex", "CODEXSTORY.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("does not write CODEXSTORY.md when guard rejects the path", async () => {
		const fakeProjectRoot = join(tempDir, "project-no-write");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig();

		try {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
		} catch {
			// Expected
		}

		// Verify CODEXSTORY.md was NOT written
		const claudeMdPath = join(fakeProjectRoot, ".codex", "CODEXSTORY.md");
		const exists = await Bun.file(claudeMdPath).exists();
		expect(exists).toBe(false);
	});

	test("succeeds for worktree with .codexstory/config.yaml (dogfooding scenario)", async () => {
		// When dogfooding on codexstory's own repo, .codexstory/config.yaml is tracked
		// in git. Every worktree checkout includes it. The old file-existence heuristic
		// would incorrectly reject these worktrees. The path-comparison guard must allow
		// writes because the worktree path differs from the canonical root (codexstory-p4st).
		const fakeProjectRoot = join(tempDir, "codexstory-dogfood");
		const worktreePath = join(fakeProjectRoot, ".codexstory", "worktrees", "dogfood-agent");
		await mkdir(join(worktreePath, ".codexstory"), { recursive: true });
		// Simulate tracked .codexstory/config.yaml appearing in the worktree checkout
		await Bun.write(
			join(worktreePath, ".codexstory", "config.yaml"),
			"project:\n  name: codexstory\n",
		);

		const config = makeConfig({ agentName: "dogfood-agent" });

		// Must succeed — worktreePath !== fakeProjectRoot even though config.yaml exists
		await writeOverlay(worktreePath, config, fakeProjectRoot);

		const outputPath = join(worktreePath, ".codex", "CODEXSTORY.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});
});

describe("isCanonicalRoot", () => {
	test("returns true when dir matches canonicalRoot", () => {
		expect(isCanonicalRoot("/projects/my-app", "/projects/my-app")).toBe(true);
	});

	test("returns true when paths resolve to the same location", () => {
		expect(isCanonicalRoot("/projects/my-app/./", "/projects/my-app")).toBe(true);
	});

	test("returns false when dir differs from canonicalRoot", () => {
		expect(
			isCanonicalRoot("/projects/my-app/.codexstory/worktrees/agent-1", "/projects/my-app"),
		).toBe(false);
	});

	test("returns false for worktree even when it contains .codexstory/config.yaml (dogfooding)", () => {
		// This is the core dogfooding scenario: the worktree has .codexstory/config.yaml
		// because it's tracked in git, but the path is different from the canonical root.
		const canonicalRoot = "/projects/codexstory";
		const worktreePath = "/projects/codexstory/.codexstory/worktrees/dogfood-agent";
		expect(isCanonicalRoot(worktreePath, canonicalRoot)).toBe(false);
	});
});
