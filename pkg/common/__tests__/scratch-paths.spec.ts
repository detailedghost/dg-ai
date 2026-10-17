import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import {
	agentsPath,
	agentsRoot,
	cwdHash,
	findAgentsDir,
	randSuffix,
	readableSuffix,
	repoRoot,
	projectHash,
	scratchDir,
	stateDir,
	uniqueName,
	scratchPath,
	statePath,
	stateRoot,
	scratchRoot,
	projectRoot,
	isPathInside,
	NotInWorktreeError,
} from "../src/node/scratch-paths";
import { scratchFixtures } from "../../skills-cli/__tests__/git-repo-fixtures";

const fixtures = scratchFixtures();
const makeTmp = () => fixtures.tmp();
const trackedEnv = ["AI_SCRATCH_DIR", "AI_STATE_DIR", "XDG_STATE_HOME"] as const;
let savedEnv: (string | undefined)[];
beforeEach(() => { savedEnv = trackedEnv.map((key) => process.env[key]); });
afterEach(() => {
	fixtures.cleanup();
	trackedEnv.forEach((key, index) => {
		if (savedEnv[index] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[index];
	});
});

// ── randSuffix ───────────────────────────────────────────────────────────────

describe("randSuffix", () => {
	test("returns default length 4", () => {
		expect(randSuffix().length).toBe(4);
	});

	test("returns requested length", () => {
		expect(randSuffix(8).length).toBe(8);
		expect(randSuffix(1).length).toBe(1);
	});

	test("only lowercase alphanumeric characters", () => {
		for (let i = 0; i < 20; i++) {
			expect(randSuffix(16)).toMatch(/^[a-z0-9]+$/);
		}
	});

	test("consecutive calls produce different values (probabilistic)", () => {
		const a = randSuffix(8);
		const b = randSuffix(8);
		// With 36^8 ≈ 2.8e12 possibilities the chance of collision is negligible
		expect(a).not.toBe(b);
	});
});

// ── readableSuffix ───────────────────────────────────────────────────────────

describe("readableSuffix", () => {
	test("is exactly two lowercase words joined by a single hyphen", () => {
		for (let i = 0; i < 50; i++) {
			expect(readableSuffix()).toMatch(/^[a-z]+-[a-z]+$/);
		}
	});

	test("is filesystem-safe — no whitespace, dots, or path separators", () => {
		for (let i = 0; i < 50; i++) {
			const s = readableSuffix();
			expect(s).not.toMatch(/[\s./\\]/);
		}
	});

	test("draws from more than one adjective and more than one noun", () => {
		// Guards against an off-by-one or a modulo bug pinning either half to one word.
		const adjectives = new Set<string>();
		const nouns = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const [adj, noun] = readableSuffix().split("-");
			adjectives.add(adj!);
			nouns.add(noun!);
		}
		expect(adjectives.size).toBeGreaterThan(1);
		expect(nouns.size).toBeGreaterThan(1);
	});

	test("never yields an undefined half", () => {
		// A modulo against the wrong array length would surface here as "undefined".
		for (let i = 0; i < 200; i++) {
			expect(readableSuffix()).not.toContain("undefined");
		}
	});
});

// ── findAgentsDir ────────────────────────────────────────────────────────────

describe("findAgentsDir", () => {
	test("finds .agents dir in the given start directory", () => {
		const root = makeTmp();
		const agentsDir = nodePath.join(root, ".agents");
		nodeFs.mkdirSync(agentsDir);

		const found = findAgentsDir(root);
		expect(found).toBe(agentsDir);
	});

	test("finds .agents dir walking up from a nested child", () => {
		const root = makeTmp();
		nodeFs.mkdirSync(nodePath.join(root, ".agents"));
		const child = nodePath.join(root, "a", "b", "c");
		nodeFs.mkdirSync(child, { recursive: true });

		const found = findAgentsDir(child);
		expect(found).toBe(nodePath.join(root, ".agents"));
	});

	test("returns null after checking every ancestor when no .agents directory exists", () => {
		const deep = nodePath.join(makeTmp(), "a", "b");
		const script = `
import { mock } from "bun:test";
const fs = await import("node:fs");
const visited = [];
mock.module("node:fs", () => ({ ...fs, statSync: (candidate) => {
	visited.push(candidate);
	throw Object.assign(new Error("missing"), { code: "ENOENT" });
} }));
const { findAgentsDir } = await import(${JSON.stringify(`${import.meta.dir}/../src/node/scratch-paths.ts`)});
process.stdout.write(JSON.stringify({ found: findAgentsDir(${JSON.stringify(deep)}), visited }));
`;
		const proc = Bun.spawnSync([process.execPath, "--eval", script]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stderr.toString()).toBe("");
		const { found, visited } = JSON.parse(proc.stdout.toString());
		expect(found).toBeNull();
		expect(visited[0]).toBe(nodePath.join(deep, ".agents"));
		expect(visited).toContain(nodePath.join(nodePath.dirname(deep), ".agents"));
		expect(visited.at(-1)).toBe(nodePath.join(nodePath.parse(deep).root, ".agents"));
	});

	test(".agents must be a directory, not a file", () => {
		const isolated = makeTmp();
		// Create .agents as a plain FILE, not a directory
		nodeFs.writeFileSync(nodePath.join(isolated, ".agents"), "not a dir");

		const found = findAgentsDir(isolated);
		// Should not return isolated/.agents since it's a file; walks up and finds null
		expect(found).not.toBe(nodePath.join(isolated, ".agents"));
	});
});

// ── scratchPath ──────────────────────────────────────────────────────────────

describe("scratchPath", () => {
	let origEnv: string | undefined;

	beforeEach(() => {
		origEnv = process.env.AI_SCRATCH_DIR;
	});

	afterEach(() => {
		if (origEnv === undefined) {
			delete process.env.AI_SCRATCH_DIR;
		} else {
			process.env.AI_SCRATCH_DIR = origEnv;
		}
	});

	test("falls back to /tmp/ai when AI_SCRATCH_DIR is not set", () => {
		delete process.env.AI_SCRATCH_DIR;

		expect(scratchRoot()).toBe("/tmp/ai");
	});

	test("uses AI_SCRATCH_DIR env var as base", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;

		const p = scratchPath("mytool", "out.txt");
		expect(p.startsWith(base)).toBe(true);
	});

	test("creates the cwd-scoped tool subdirectory if it does not exist", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;

		scratchPath("newtool");
		expect(nodeFs.existsSync(nodePath.join(base, "newtool", cwdHash()))).toBe(true);
	});

	test("returns base/tool/<cwd-hash>/name by default", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;

		const p = scratchPath("jot", "my-jot.md");
		expect(p).toBe(nodePath.join(base, "jot", cwdHash(), "my-jot.md"));
	});

	test("returns base/tool/name when cwdScope:false", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;

		const p = scratchPath("hooks", "comment-disabled.X", { cwdScope: false });
		expect(p).toBe(nodePath.join(base, "hooks", "comment-disabled.X"));
	});

	test("auto-generates a cwd-scoped timestamped path when name is omitted", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;

		const p = scratchPath("jot");
		// Pattern: base/jot/<cwd-hash>/jot-YYYYMMDD-HHMM-XXXX
		expect(p).toMatch(/\/jot\/[a-f0-9]{8}\/jot-\d{8}-\d{4}-[a-z0-9]{4}$/);
	});

	test("auto-generated paths are unique across calls", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;

		const a = scratchPath("tool");
		const b = scratchPath("tool");
		expect(a).not.toBe(b);
	});

	test("ephemeral option accepted without error", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;

		expect(() => scratchPath("tool", "f.txt", { ephemeral: true })).not.toThrow();
	});
});

// ── repoRoot ─────────────────────────────────────────────────────────────────

describe("repoRoot", () => {
	test("returns a non-empty string when run inside a git repo (temp init)", () => {
		const repo = makeTmp();
		Bun.spawnSync(["git", "init"], { cwd: repo });

		// repoRoot reads process.cwd() via Bun.spawnSync; invoke in a subprocess
		// so we can control cwd without mutating the outer process.
		const proc = Bun.spawnSync(
			[
				"bun",
				"--eval",
				`import { repoRoot } from "${import.meta.dir}/../src/node/scratch-paths"; console.log(JSON.stringify(repoRoot()));`,
			],
			{ cwd: repo, env: { ...process.env } },
		);
		const value = JSON.parse(proc.stdout.toString().trim());
		expect(typeof value).toBe("string");
		expect(value.length).toBeGreaterThan(0);
	});

	test("returns null when not inside a git repo", () => {
		const nonRepo = makeTmp();

		const proc = Bun.spawnSync(
			[
				"bun",
				"--eval",
				`import { repoRoot } from "${import.meta.dir}/../src/node/scratch-paths"; console.log(JSON.stringify(repoRoot()));`,
			],
			{ cwd: nonRepo, env: { ...process.env } },
		);
		const value = JSON.parse(proc.stdout.toString().trim());
		expect(value).toBeNull();
	});
});

// ── statePath ────────────────────────────────────────────────────────────────

describe("statePath", () => {
	let origState: string | undefined;
	let origXdg: string | undefined;
	let origScratch: string | undefined;

	beforeEach(() => {
		origState = process.env.AI_STATE_DIR;
		origXdg = process.env.XDG_STATE_HOME;
		origScratch = process.env.AI_SCRATCH_DIR;
	});

	afterEach(() => {
		for (const [k, v] of [
			["AI_STATE_DIR", origState],
			["XDG_STATE_HOME", origXdg],
			["AI_SCRATCH_DIR", origScratch],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	test("falls back to ~/.local/state/ai when nothing is set", () => {
		delete process.env.AI_STATE_DIR;
		delete process.env.XDG_STATE_HOME;

		expect(stateRoot()).toBe(nodePath.join(nodeOs.homedir(), ".local", "state", "ai"));
	});

	test("never resolves under ~/.cache, which XDG may delete at any time", () => {
		delete process.env.AI_STATE_DIR;
		delete process.env.XDG_STATE_HOME;

		expect(stateRoot()).not.toContain("/.cache/");
	});

	test("honors XDG_STATE_HOME", () => {
		delete process.env.AI_STATE_DIR;
		process.env.XDG_STATE_HOME = "/tmp/xdg-state-test";

		expect(stateRoot()).toBe("/tmp/xdg-state-test/ai");
	});

	test("AI_STATE_DIR wins over XDG_STATE_HOME", () => {
		process.env.XDG_STATE_HOME = "/tmp/xdg-state-test";
		process.env.AI_STATE_DIR = "/tmp/explicit-state-test";

		expect(stateRoot()).toBe("/tmp/explicit-state-test");
	});

	test("is unaffected by AI_SCRATCH_DIR — the two roots are independent", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;
		process.env.AI_STATE_DIR = makeTmp();

		expect(statePath("mytool", "out.txt").startsWith(base)).toBe(false);
	});

	test("keys on projectHash, not cwdHash, so it survives the producing worktree", () => {
		const base = makeTmp();
		// Needs a real repo: outside one projectRoot() falls back to cwd and the two
		// hashes collapse, which would make this assertion vacuous.
		const repo = makeTmp();
		Bun.spawnSync(["git", "init", "-q", repo]);
		const subdir = nodePath.join(repo, "nested", "deep");
		nodeFs.mkdirSync(subdir, { recursive: true });

		const proc = Bun.spawnSync(
			[
				"bun",
				"--eval",
				`import { statePath, cwdHash, projectHash } from "${import.meta.dir}/../src/node/scratch-paths";` +
					`console.log(JSON.stringify({ p: statePath("mytool", "out.txt"), c: cwdHash(), h: projectHash() }));`,
			],
			{ cwd: subdir, env: { ...process.env, AI_STATE_DIR: base } },
		);
		const { p, c, h } = JSON.parse(proc.stdout.toString().trim());

		expect(c).not.toBe(h); // guard: the subdir must not resolve to the main worktree
		expect(p).toBe(nodePath.join(base, "mytool", h, "out.txt"));
		expect(p).not.toContain(c);
	});

	test("shares one layout with scratchPath — global scope drops the bucket", () => {
		const base = makeTmp();
		process.env.AI_STATE_DIR = base;

		expect(statePath("bg", "job.log", { cwdScope: false })).toBe(nodePath.join(base, "bg", "job.log"));
	});

	test("rejects a traversing name", () => {
		process.env.AI_STATE_DIR = makeTmp();

		expect(() => statePath("mytool", "../escape.txt")).toThrow();
	});
});

function linkedWorktreeFixture(): { main: string; linked: string } {
	return fixtures.repo();
}

describe("uniqueName", () => {
	test("is tool, date, time, and a random suffix", () => {
		expect(uniqueName("pw")).toMatch(/^pw-\d{8}-\d{4}-[a-z0-9]{4}$/);
	});

	test("appends the suffix verbatim", () => {
		expect(uniqueName("pw", ".zip")).toMatch(/^pw-\d{8}-\d{4}-[a-z0-9]{4}\.zip$/);
	});
});

describe("cwd option", () => {
	test("cwdHash and projectHash accept a directory", () => {
		const { main, linked } = linkedWorktreeFixture();
		expect(cwdHash(main)).not.toBe(cwdHash(linked));
		expect(projectHash(linked)).toBe(projectHash(main));
	});

	test("scratchPath and statePath bucket by the given cwd", () => {
		const { main, linked } = linkedWorktreeFixture();
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = base;
		process.env.AI_STATE_DIR = base;
		try {
			expect(scratchPath("t", "f", { cwd: linked })).toBe(nodePath.join(base, "t", cwdHash(linked), "f"));
			expect(statePath("t", "f", { cwd: linked })).toBe(nodePath.join(base, "t", projectHash(main), "f"));
			expect(scratchDir("t", { cwd: main, cwdScope: false })).toBe(nodePath.join(base, "t"));
			expect(stateDir("t", { cwd: main })).toBe(nodePath.join(base, "t", projectHash(main)));
		} finally {
			delete process.env.AI_SCRATCH_DIR;
			delete process.env.AI_STATE_DIR;
		}
	});

	test("creates new dirs with mode 0700", () => {
		const base = makeTmp();
		process.env.AI_SCRATCH_DIR = nodePath.join(base, "root");
		try {
			const dir = scratchDir("t");
			expect(nodeFs.statSync(dir).mode & 0o777).toBe(0o700);
		} finally {
			delete process.env.AI_SCRATCH_DIR;
		}
	});
});

describe("agentsRoot and agentsPath", () => {
	test("resolve the current worktree or the main worktree", () => {
		const { main, linked } = linkedWorktreeFixture();
		expect(agentsRoot({ cwd: linked })).toBe(nodePath.join(linked, ".agents"));
		expect(agentsRoot({ cwd: linked, main: true })).toBe(nodePath.join(main, ".agents"));
	});

	test("create the tool dir, or the name's parent", () => {
		const { main } = linkedWorktreeFixture();
		const dir = agentsPath("proto", undefined, { cwd: main });
		expect(dir).toBe(nodePath.join(main, ".agents", "proto"));
		expect(nodeFs.statSync(dir).isDirectory()).toBe(true);
		const file = agentsPath("proto", "a/b.md", { cwd: main });
		expect(file).toBe(nodePath.join(main, ".agents", "proto", "a", "b.md"));
		expect(nodeFs.statSync(nodePath.dirname(file)).isDirectory()).toBe(true);
		expect(nodeFs.existsSync(file)).toBe(false);
	});

	test("throw outside a git worktree", () => {
		const outside = makeTmp();
		expect(() => agentsPath("proto", "x", { cwd: outside })).toThrow("not in a git worktree");
	});
});

describe("projectRoot", () => {
	test("resolves the main repository from both worktrees and nested directories", () => {
		const { main, linked } = fixtures.repo();
		const nested = nodePath.join(linked, "nested");
		nodeFs.mkdirSync(nested);
		expect(projectRoot(main)).toBe(main);
		expect(projectRoot(nested)).toBe(main);
		expect(repoRoot(nested)).toBe(linked);
	});
	test("uses the supplied cwd outside a repository", () => {
		const outside = makeTmp();
		expect(projectRoot(outside)).toBe(outside);
		expect(projectHash(outside)).toBe(cwdHash(outside));
	});
});

describe("isPathInside", () => {
	test("compares path segments including normalized paths and the filesystem root", () => {
		const root = makeTmp();
		expect(isPathInside(root, root)).toBe(true);
		expect(isPathInside(nodePath.join(root, "child"), root)).toBe(true);
		expect(isPathInside(`${root}-sibling`, root)).toBe(false);
		expect(isPathInside(nodePath.join(root, "..", "other"), root)).toBe(false);
		expect(isPathInside(root, nodePath.parse(root).root)).toBe(true);
	});
});

describe("NotInWorktreeError", () => {
	test("agentsRoot exposes the typed error outside git", () => {
		expect(() => agentsRoot({ cwd: makeTmp() })).toThrow(NotInWorktreeError);
	});
});
