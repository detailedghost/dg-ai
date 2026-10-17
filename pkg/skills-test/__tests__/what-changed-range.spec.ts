import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRange, type Run } from "../../../plugins/dg/skills/what-changed/scripts/range";
import { REPO_ROOT } from "./test-support";

const RANGE_SCRIPT = join(REPO_ROOT, "plugins", "dg", "skills", "what-changed", "scripts", "range.ts");
const HOSTILE_TAG = "v1$(touch pwned)";
const HOSTILE_BRANCH = "main$(touch pwned)";

describe("discoverRange", () => {
	test("passes a hostile release tag to git as one argument", async () => {
		const calls: string[][] = [];
		const run: Run = async (file, args) => {
			calls.push([file, ...args]);
			if (file === "gh") return JSON.stringify([{ tagName: HOSTILE_TAG }]);
			if (args[0] === "remote") return "https://github.com/example/repo.git";
			if (args[0] === "symbolic-ref") return "origin/main";
			if (args[0] === "rev-parse") return "abc123";
			return "";
		};

		const report = await discoverRange(run);

		expect(report.lastRelease).toBe(HOSTILE_TAG);
		expect(report.range).toBe(`${HOSTILE_TAG}..origin/main`);
		expect(calls).toContainEqual(["git", "rev-parse", "-q", "--verify", `refs/tags/${HOSTILE_TAG}`]);
		expect(calls.some((call) => call[0] === "sh" || call.includes("-c"))).toBe(false);
	});

	test("passes a hostile default branch to git tag as one argument", async () => {
		const calls: string[][] = [];
		const run: Run = async (file, args) => {
			calls.push([file, ...args]);
			if (file === "gh") return "[]";
			if (args[0] === "remote") return "https://github.com/example/repo.git";
			if (args[0] === "symbolic-ref") return `origin/${HOSTILE_BRANCH}`;
			return "";
		};

		const report = await discoverRange(run);

		expect(report.range).toBe(`origin/${HOSTILE_BRANCH}`);
		expect(calls).toContainEqual([
			"git",
			"tag",
			"--merged",
			`origin/${HOSTILE_BRANCH}`,
			"--sort=-v:refname",
		]);
		expect(calls.some((call) => call[0] === "sh" || call.includes("-c"))).toBe(false);
	});
});

describe("range.ts process", () => {
	test("a hostile release tag does not run through the shell", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-range-"));
		const bin = join(dir, "bin");
		const repo = join(dir, "repo");
		const gitLog = join(dir, "git.log");
		mkdirSync(bin);
		mkdirSync(repo);
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh
printf '%s\\n' "$@" >> "$DG_GIT_LOG"
case "$1" in
  remote) printf '%s\\n' "https://github.com/example/repo.git" ;;
  symbolic-ref) printf '%s\\n' "origin/main" ;;
  rev-parse) printf '%s\\n' "abc123" ;;
esac
`,
		);
		writeFileSync(
			join(bin, "gh"),
			`#!/bin/sh
printf '%s\\n' '[{"tagName":"v1$(touch pwned)"}]'
`,
		);
		chmodSync(join(bin, "git"), 0o755);
		chmodSync(join(bin, "gh"), 0o755);
		try {
			const proc = Bun.spawn(["bun", RANGE_SCRIPT], {
				cwd: repo,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					DG_GIT_LOG: gitLog,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			const code = await proc.exited;
			expect(code).toBe(0);
			expect(stdout).toContain(HOSTILE_TAG);
			expect(existsSync(join(repo, "pwned"))).toBe(false);
			expect(existsSync(join(dir, "pwned"))).toBe(false);
			expect(readFileSync(gitLog, "utf8")).toContain(`refs/tags/${HOSTILE_TAG}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
