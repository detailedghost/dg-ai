import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { scratchFixtures } from "../../skills-cli/__tests__/git-repo-fixtures";
import {
	agentsPath,
	agentsRoot,
	cwdHash,
	findAgentsDir,
	isPathInside,
	NotInWorktreeError,
	projectHash,
	projectRoot,
	randSuffix,
	repoRoot,
	scratchDir,
	scratchPath,
	scratchRoot,
	stateDir,
	statePath,
	stateRoot,
	uniqueName,
} from "../src/node/scratch-paths";

const fixtures = scratchFixtures();
const makeTmp = () => fixtures.tmp();
const trackedEnv = [
	"AI_SCRATCH_DIR",
	"AI_STATE_DIR",
	"XDG_STATE_HOME",
] as const;
let savedEnv: (string | undefined)[];
beforeEach(() => {
	savedEnv = trackedEnv.map((key) => process.env[key]);
});
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

	test("ignores a nested tree that holds no .agents directory", () => {
		const root = makeTmp();
		const deep = nodePath.join(root, "a", "b");
		nodeFs.mkdirSync(deep, { recursive: true });

		const found = findAgentsDir(deep);
		expect(found === null || !isPathInside(found, root)).toBe(true);
	});

	test(".agents must be a directory, not a file", () => {
		const isolated = makeTmp();
		nodeFs.writeFileSync(nodePath.join(isolated, ".agents"), "not a dir");

		const found = findAgentsDir(isolated);
		expect(found === null || !isPathInside(found, isolated)).toBe(true);
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

	test("falls back to /tmp/ai when AI_SCRATCH_DIR is empty", () => {
		process.env.AI_SCRATCH_DIR = "";

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
		expect(nodeFs.existsSync(nodePath.join(base, "newtool", cwdHash()))).toBe(
			true,
		);
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

});

// ── repoRoot ─────────────────────────────────────────────────────────────────

describe("managed scratch and state directories", () => {
	for (const { env, getDir, getHash } of [
		{ env: "AI_SCRATCH_DIR", getDir: scratchDir, getHash: cwdHash },
		{ env: "AI_STATE_DIR", getDir: stateDir, getHash: projectHash },
	] as const) {
		test(`${env} makes existing tool and bucket directories private before returning them`, () => {
			const base = makeTmp();
			process.env[env] = base;
			const tool = nodePath.join(base, "private-artifacts");
			const bucket = nodePath.join(tool, getHash());
			nodeFs.mkdirSync(bucket, { recursive: true });
			for (const dir of [tool, bucket]) nodeFs.chmodSync(dir, 0o755);

			expect(getDir("private-artifacts")).toBe(bucket);
			for (const dir of [tool, bucket]) {
				expect(nodeFs.statSync(dir).mode & 0o777).toBe(0o700);
			}
		});

		for (const descendant of ["tool", "bucket"] as const) {
			test(`${env} rejects a symlinked ${descendant} without modifying its target`, () => {
				const base = makeTmp();
				const outside = makeTmp();
				process.env[env] = base;
				const marker = nodePath.join(outside, "existing-plan.md");
				nodeFs.writeFileSync(marker, "preserve this plan");
				nodeFs.chmodSync(outside, 0o755);
				const tool = nodePath.join(base, "private-artifacts");
				if (descendant === "bucket") nodeFs.mkdirSync(tool);
				const link =
					descendant === "tool" ? tool : nodePath.join(tool, getHash());
				nodeFs.symlinkSync(outside, link);

				expect(() => getDir("private-artifacts")).toThrow();
				expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(true);
				expect(nodeFs.statSync(outside).mode & 0o777).toBe(0o755);
				expect(nodeFs.readdirSync(outside)).toEqual(["existing-plan.md"]);
				expect(nodeFs.readFileSync(marker, "utf8")).toBe("preserve this plan");
			});
		}

		for (const linkedRoot of [false, true]) {
			test(`${env} rejects an unsafe writable root ancestor${linkedRoot ? " behind a configured symlink" : ""}`, () => {
				const boundary = makeTmp();
				const parent = nodePath.join(boundary, "shared");
				const base = nodePath.join(parent, "artifacts");
				nodeFs.mkdirSync(base, { recursive: true });
				nodeFs.chmodSync(parent, 0o777);
				const configured = linkedRoot
					? nodePath.join(makeTmp(), "configured-root")
					: base;
				if (linkedRoot) nodeFs.symlinkSync(base, configured);
				process.env[env] = configured;

				expect(() => getDir("private-artifacts")).toThrow();
				expect(nodeFs.statSync(parent).mode & 0o777).toBe(0o777);
				expect(nodeFs.readdirSync(base)).toEqual([]);
			});
		}

		test(`${env} accepts an explicitly configured root symlink into a safe directory`, () => {
			const target = makeTmp();
			nodeFs.chmodSync(target, 0o755);
			const link = nodePath.join(makeTmp(), "configured-root");
			nodeFs.symlinkSync(target, link);
			process.env[env] = link;

			const dir = getDir("private-artifacts");
			expect(nodeFs.realpathSync(dir)).toBe(
				nodePath.join(target, "private-artifacts", getHash()),
			);
			expect(nodeFs.statSync(dir).mode & 0o777).toBe(0o700);
			expect(nodeFs.statSync(target).mode & 0o777).toBe(0o755);
			expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(true);
		});
	}

	test("rejects a symlinked default state root in an isolated HOME", () => {
		const home = makeTmp();
		const outside = makeTmp();
		const parent = nodePath.join(home, ".local", "state");
		nodeFs.mkdirSync(parent, { recursive: true });
		nodeFs.symlinkSync(outside, nodePath.join(parent, "ai"));

		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`
import { stateRoot, stateDir } from ${JSON.stringify(`${import.meta.dir}/../src/node/scratch-paths.ts`)};
let rejected = false;
try { stateDir("private-artifacts"); } catch { rejected = true; }
console.log(JSON.stringify({ root: stateRoot(), rejected }));
`,
			],
			{
				env: {
					...process.env,
					HOME: home,
					AI_STATE_DIR: undefined,
					XDG_STATE_HOME: undefined,
				},
			},
		);
		expect(proc.exitCode).toBe(0);
		const result = JSON.parse(proc.stdout.toString());
		expect(result.root).toBe(nodePath.join(parent, "ai"));
		expect(result.rejected).toBe(true);
		expect(nodeFs.readdirSync(outside)).toEqual([]);
	});

	for (const competingEntry of ["directory", "symlink"] as const) {
		test(`validates a competing ${competingEntry} created during first use`, () => {
			const root = makeTmp();
			const outside = makeTmp();
			const tool = nodePath.join(root, "concurrent-artifacts");
			const proc = Bun.spawnSync(
				[
					process.execPath,
					"--eval",
					`
import { mock } from "bun:test";
const fs = await import("node:fs");
const originalMkdir = fs.mkdirSync;
const originalSymlink = fs.symlinkSync;
let injected = false;
mock.module("node:fs", () => ({ ...fs, mkdirSync(candidate, options) {
	if (!injected && candidate === ${JSON.stringify(tool)}) {
		injected = true;
		${competingEntry === "directory" ? "originalMkdir(candidate, { mode: 0o755 });" : `originalSymlink(${JSON.stringify(outside)}, candidate);`}
	}
	return originalMkdir(candidate, options);
} }));
const { scratchDir } = await import(${JSON.stringify(`${import.meta.dir}/../src/node/scratch-paths.ts`)});
let dir = null;
let rejected = false;
try { dir = scratchDir("concurrent-artifacts", { cwdScope: false }); } catch { rejected = true; }
console.log(JSON.stringify({ injected, dir, rejected }));
`,
				],
				{ env: { ...process.env, AI_SCRATCH_DIR: root } },
			);
			expect(proc.exitCode).toBe(0);
			const result = JSON.parse(proc.stdout.toString());
			expect(result.injected).toBe(true);
			expect(result.rejected).toBe(competingEntry === "symlink");
			if (competingEntry === "directory") {
				expect(result.dir).toBe(tool);
				expect(nodeFs.statSync(tool).mode & 0o777).toBe(0o700);
			} else {
				expect(nodeFs.lstatSync(tool).isSymbolicLink()).toBe(true);
				expect(nodeFs.readdirSync(outside)).toEqual([]);
			}
		});
	}
});

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

		expect(stateRoot()).toBe(
			nodePath.join(nodeOs.homedir(), ".local", "state", "ai"),
		);
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

		expect(statePath("bg", "job.log", { cwdScope: false })).toBe(
			nodePath.join(base, "bg", "job.log"),
		);
	});

	test("rejects a traversing name", () => {
		process.env.AI_STATE_DIR = makeTmp();

		expect(() => statePath("mytool", "../escape.txt")).toThrow();
	});

	test("rejects nested names and accepts dots inside a plain filename", () => {
		const base = makeTmp();
		process.env.AI_STATE_DIR = base;

		expect(() => statePath("mytool", "sub/file")).toThrow();
		expect(() => statePath("mytool", "..")).toThrow();
		expect(statePath("mytool", "v1..2.txt", { cwdScope: false })).toBe(
			nodePath.join(base, "mytool", "v1..2.txt"),
		);
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
		expect(uniqueName("pw", ".zip")).toMatch(
			/^pw-\d{8}-\d{4}-[a-z0-9]{4}\.zip$/,
		);
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
			expect(scratchPath("t", "f", { cwd: linked })).toBe(
				nodePath.join(base, "t", cwdHash(linked), "f"),
			);
			expect(statePath("t", "f", { cwd: linked })).toBe(
				nodePath.join(base, "t", projectHash(main), "f"),
			);
			expect(scratchDir("t", { cwd: main, cwdScope: false })).toBe(
				nodePath.join(base, "t"),
			);
			expect(stateDir("t", { cwd: main })).toBe(
				nodePath.join(base, "t", projectHash(main)),
			);
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
		expect(agentsRoot({ cwd: linked, main: true })).toBe(
			nodePath.join(main, ".agents"),
		);
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
		expect(() => agentsPath("proto", "x", { cwd: outside })).toThrow(
			"not in a git worktree",
		);
	});

	test("reject names that escape the tool directory without creating anything", () => {
		const { main } = linkedWorktreeFixture();
		expect(() =>
			agentsPath("proto", "../../outside/y", { cwd: main }),
		).toThrow("inside");
		expect(() => agentsPath("../escape", "x", { cwd: main })).toThrow("inside");
		expect(nodeFs.existsSync(nodePath.join(main, "outside"))).toBe(false);
		expect(nodeFs.existsSync(nodePath.join(main, ".agents", "proto"))).toBe(
			false,
		);
	});

	test("report a missing git binary as outside a worktree", () => {
		const outside = makeTmp();
		const savedPath = process.env.PATH;
		process.env.PATH = outside;
		try {
			expect(repoRoot(outside)).toBeNull();
			expect(() => agentsRoot({ cwd: outside })).toThrow(NotInWorktreeError);
		} finally {
			process.env.PATH = savedPath;
		}
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
