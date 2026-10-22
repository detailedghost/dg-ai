import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AmbiguousPrototypeError,
	changesPath,
	decisionPath,
	prototypeDir,
	selectionPath,
} from "../../src/prototype/paths";

const cleanupDirs: string[] = [];

function freshDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanupDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], { cwd });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString()}`);
	}
}

interface Rig {
	main: string;
	holder: string;
	addWorktree(dirName: string, branch: string): string;
}

function makeRig(): Rig {
	const main = freshDir("proto-paths-rig-main-");
	const holder = freshDir("proto-paths-rig-worktrees-");
	git(["init", "-q"], main);
	git(["config", "user.email", "test@test.com"], main);
	git(["config", "user.name", "test"], main);
	git(["commit", "--allow-empty", "-q", "-m", "init"], main);
	return {
		main,
		holder,
		addWorktree(dirName: string, branch: string): string {
			const wtPath = join(holder, dirName);
			git(["worktree", "add", "-q", "-b", branch, wtPath], main);
			return wtPath;
		},
	};
}

describe("prototypeDir — durable (non-light) mode", () => {
	test("resolves from the repo root that actually holds the prototype", async () => {
		const rig = makeRig();
		mkdirSync(join(rig.main, ".agents/prototype/local-proto"), { recursive: true });

		const dir = await prototypeDir("local-proto", { cwd: rig.main });

		expect(dir).toBe(join(rig.main, ".agents/prototype/local-proto"));
	});

	test("finds the prototype in a sibling worktree when run from an unrelated worktree of the same repo", async () => {
		const rig = makeRig();
		const wtA = rig.addWorktree("wt-a", "feature-a");
		const wtB = rig.addWorktree("wt-b", "feature-b");
		mkdirSync(join(wtA, ".agents/prototype/shared-proto"), { recursive: true });

		const dir = await prototypeDir("shared-proto", { cwd: wtB });

		expect(dir).toBe(join(wtA, ".agents/prototype/shared-proto"));
	});

	test("resolves the same directory (no nested doubling) when run from inside the prototype dir itself", async () => {
		const rig = makeRig();
		const protoDir = join(rig.main, ".agents/prototype/nested-check");
		mkdirSync(protoDir, { recursive: true });

		const dir = await prototypeDir("nested-check", { cwd: protoDir });

		expect(dir).toBe(protoDir);
		expect(dir).not.toContain("nested-check/.agents/prototype/nested-check");
	});

	test("throws with every candidate listed when the same name exists in two sibling worktrees", async () => {
		const rig = makeRig();
		const wtA = rig.addWorktree("wt-a", "feature-a");
		const wtB = rig.addWorktree("wt-b", "feature-b");
		mkdirSync(join(wtA, ".agents/prototype/dup-proto"), { recursive: true });
		mkdirSync(join(wtB, ".agents/prototype/dup-proto"), { recursive: true });

		await expect(prototypeDir("dup-proto", { cwd: rig.main })).rejects.toThrow(
			AmbiguousPrototypeError,
		);
		try {
			await prototypeDir("dup-proto", { cwd: rig.main });
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(AmbiguousPrototypeError);
			const message = (error as Error).message;
			expect(message).toContain('ambiguous prototype "dup-proto"');
			expect(message).toContain(join(wtA, ".agents/prototype/dup-proto"));
			expect(message).toContain(join(wtB, ".agents/prototype/dup-proto"));
		}
	});

	test("falls back to creating under cwd when no existing copy is found anywhere in the repo", async () => {
		const rig = makeRig();
		rig.addWorktree("wt-a", "feature-a");

		const dir = await prototypeDir("brand-new", { cwd: rig.main });

		expect(dir).toBe(join(rig.main, ".agents/prototype/brand-new"));
	});

	test("a selection written in one worktree is visible from a sibling", async () => {
		const rig = makeRig();
		const wtA = rig.addWorktree("wt-a", "feature-a");
		const wtB = rig.addWorktree("wt-b", "feature-b");
		mkdirSync(join(wtA, ".agents/prototype/decided-proto"), { recursive: true });

		const pathFromA = await selectionPath("decided-proto", { cwd: wtA });
		const pathFromB = await selectionPath("decided-proto", { cwd: wtB });

		expect(pathFromA).toBe(pathFromB);
		expect(pathFromA).toBe(join(wtA, ".agents/prototype/decided-proto/.selection"));
	});
});

describe("prototypeDir — --light mode", () => {
	test("is unaffected by git worktrees: resolves under the cwd-hash scratch dir, no search applied", async () => {
		const rig = makeRig();
		rig.addWorktree("wt-a", "feature-a");
		const scratch = freshDir("proto-paths-light-scratch-");
		const originalScratchDir = process.env.AI_SCRATCH_DIR;
		process.env.AI_SCRATCH_DIR = scratch;
		try {
			const dir = await prototypeDir("light-proto", { cwd: rig.main, light: true });
			expect(dir.startsWith(join(scratch, "prototype"))).toBe(true);
			expect(dir).not.toContain(".agents/prototype");
		} finally {
			if (originalScratchDir === undefined) delete process.env.AI_SCRATCH_DIR;
			else process.env.AI_SCRATCH_DIR = originalScratchDir;
		}
	});

	test("decision/changes paths sit next to the selection sentinel", async () => {
		const scratch = freshDir("proto-paths-light-decision-");
		const originalScratchDir = process.env.AI_SCRATCH_DIR;
		process.env.AI_SCRATCH_DIR = scratch;
		try {
			const cwd = freshDir("proto-paths-light-decision-cwd-");
			const [selection, decision, changes] = await Promise.all([
				selectionPath("light-decision", { cwd, light: true }),
				decisionPath("light-decision", { cwd, light: true }),
				changesPath("light-decision", { cwd, light: true }),
			]);
			expect(decision.replace(/\.decision$/, "")).toBe(selection.replace(/\.selection$/, ""));
			expect(changes.replace(/\.changes$/, "")).toBe(selection.replace(/\.selection$/, ""));
		} finally {
			if (originalScratchDir === undefined) delete process.env.AI_SCRATCH_DIR;
			else process.env.AI_SCRATCH_DIR = originalScratchDir;
		}
	});
});
