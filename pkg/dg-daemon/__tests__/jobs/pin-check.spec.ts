import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJobEntry } from "../../src/jobs/config";
import { launchJob, startJobRun } from "../../src/jobs/launcher";
import { assertJobPinned } from "../../src/jobs/pin-check";
import { type GitSourceRecord, writeSource } from "../../src/jobs/sources";

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "bot",
	GIT_AUTHOR_EMAIL: "bot@example.invalid",
	GIT_COMMITTER_NAME: "bot",
	GIT_COMMITTER_EMAIL: "bot@example.invalid",
};

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function rig() {
	const root = mkdtempSync(join(tmpdir(), "dg-pin-check-"));
	roots.push(root);
	const paths = {
		jobsDir: join(root, "jobs"),
		jobSourcesPath: join(root, "jobs", "sources.json"),
		logDir: join(root, "logs"),
		grantsDir: join(root, "grants"),
		jobStateRoot: join(root, "state", "jobs"),
	};
	const clone = join(paths.jobsDir, "tools");
	mkdirSync(clone, { recursive: true });
	git(clone, "init", "-b", "main");
	writeFileSync(join(clone, "run.sh"), "echo hi\n");
	git(clone, "add", ".");
	git(clone, "commit", "-m", "first");
	const sha = git(clone, "rev-parse", "HEAD");
	const tree = git(clone, "rev-parse", "HEAD^{tree}");
	const record = (extra: Partial<GitSourceRecord> = {}): GitSourceRecord => ({
		kind: "git",
		url: "file:///x",
		ref: null,
		sha,
		jobs: ["bot"],
		declarationHash: "h",
		credentials: {},
		pin: { kind: "commit", value: sha },
		tree,
		...extra,
	});
	const save = (extra: Partial<GitSourceRecord> = {}) => writeSource(paths, "tools", record(extra));
	return { root, paths, clone, sha, tree, save };
}

describe("assertJobPinned", () => {
	it("accepts a clone at the pinned commit and tree", () => {
		const { paths, save } = rig();
		save();
		expect(() => assertJobPinned("bot", paths)).not.toThrow();
	});

	it("ignores a job that has no source record", () => {
		const { paths } = rig();
		expect(() => assertJobPinned("bot", paths)).not.toThrow();
	});

	it("refuses a clone whose HEAD moved off the pinned commit", () => {
		const { paths, clone, save } = rig();
		save();
		writeFileSync(join(clone, "run.sh"), "echo evil\n");
		git(clone, "commit", "-am", "tamper");
		expect(() => assertJobPinned("bot", paths)).toThrow(/not the pinned commit.*Next:/s);
	});

	it("refuses a clone whose tree differs from the recorded tree", () => {
		const { paths, save } = rig();
		save({ tree: "0".repeat(40) });
		expect(() => assertJobPinned("bot", paths)).toThrow(/tree.*Next:/s);
	});

	it("refuses a record that still carries a sha256 pin", () => {
		const { paths, save } = rig();
		save({ pin: { kind: "sha256", value: "a".repeat(64) } });
		expect(() => assertJobPinned("bot", paths)).toThrow(/sha256.*dg job remove bot/s);
	});

	it("checks the recorded sha of a record from before pins", () => {
		const { paths, clone, sha, save } = rig();
		save({ pin: undefined, tree: undefined });
		expect(() => assertJobPinned("bot", paths)).not.toThrow();
		writeFileSync(join(clone, "run.sh"), "echo evil\n");
		git(clone, "commit", "-am", "tamper");
		expect(git(clone, "rev-parse", "HEAD")).not.toBe(sha);
		expect(() => assertJobPinned("bot", paths)).toThrow(/not the pinned commit/);
	});
});

describe("job launch with a pin check", () => {
	it("starts no process for a tampered clone", () => {
		const { root, paths, clone, save } = rig();
		save();
		writeFileSync(join(clone, "run.sh"), "echo evil\n");
		git(clone, "commit", "-am", "tamper");
		const parsed = parseJobEntry("bot", { argv: [process.execPath, "-e", "0"], cwd: root, continuous: true });
		if (!parsed.ok) throw new Error(parsed.error);
		const deps = {
			paths,
			daemonUrl: () => "http://127.0.0.1:1",
			logger: { warn: () => {} },
			maxLogBytes: 1_000_000,
			readCredential: () => undefined,
		};
		expect(() => launchJob(parsed, deps)).toThrow(/not the pinned commit/);
		expect(() => startJobRun(parsed, deps)).toThrow(/not the pinned commit/);
	});
});
