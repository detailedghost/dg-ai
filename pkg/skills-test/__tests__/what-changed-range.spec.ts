import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRange, execRun, type Run } from "../../../plugins/dg/skills/what-changed/scripts/range";
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

describe("discoverRange explicit range", () => {
	test("returns an explicit range as given", async () => {
		const report = await discoverRange(async () => "", "v1.0.0..v1.1.0");

		expect(report).toEqual({ range: "v1.0.0..v1.1.0", source: "explicit" });
	});

	test("rejects an explicit range that starts with a dash", async () => {
		await expect(discoverRange(async () => "", "--output=/tmp/x")).rejects.toThrow('must not start with "-"');
	});
});

describe("discoverRange failures", () => {
	const healthy: Run = async (file, args) => {
		if (args[0] === "remote") return "https://github.com/example/repo.git";
		if (args[0] === "symbolic-ref") return "origin/main";
		return file === "gh" ? "[]" : "";
	};

	test("a failed git fetch stops the range instead of guessing", async () => {
		const run: Run = async (file, args) => {
			if (file === "git" && args[0] === "fetch") throw new Error("fetch failed");
			return healthy(file, args);
		};
		await expect(discoverRange(run)).rejects.toThrow("fetch failed");
	});

	test("a failed git tag listing stops the range instead of reporting the whole history", async () => {
		const run: Run = async (file, args) => {
			if (file === "git" && args[0] === "tag") throw new Error("bad ref");
			return healthy(file, args);
		};
		await expect(discoverRange(run)).rejects.toThrow("bad ref");
	});

	test("a missing provider CLI falls back to semver tags", async () => {
		const run: Run = async (file, args) => {
			if (file === "gh") throw new Error("gh not found");
			if (args[0] === "tag") return "v2.0.0\nv1.0.0";
			if (args[0] === "rev-parse") return "abc";
			return healthy(file, args);
		};
		const report = await discoverRange(run);
		expect(report.source).toBe("semver-tag");
		expect(report.range).toBe("v2.0.0..origin/main");
	});

	test.each([
		["https://gitlab.com/group/repo.git", "glab"],
		["git@gitlab.com:group/repo.git", "glab"],
		["ssh://git@gitlab.example.com/group/repo.git", "glab"],
		["https://github.com/gitlab/repo.git", "gh"],
		["git@github.com:example/gitlab-tools.git", "gh"],
	])("%s uses %s for provider calls", async (url, cli) => {
		const files = new Set<string>();
		const run: Run = async (file, args) => {
			if (file === "gh" || file === "glab") files.add(file);
			if (args[0] === "remote") return url;
			if (args[0] === "symbolic-ref") return "";
			return "";
		};
		await discoverRange(run).catch(() => undefined);
		expect([...files]).toEqual([cli]);
	});
});

describe("execRun", () => {
	test("rejects with the command stderr when the command fails", async () => {
		await expect(
			execRun(process.execPath, ["-e", "console.error('boom'); process.exit(3)"]),
		).rejects.toThrow("boom");
	});

	test("returns trimmed stdout on success", async () => {
		expect(await execRun(process.execPath, ["-e", "console.log('ok')"])).toBe("ok");
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
			const proc = Bun.spawn([process.execPath, RANGE_SCRIPT], {
				cwd: repo,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					DG_GIT_LOG: gitLog,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			expect(stdout).toContain(HOSTILE_TAG);
			expect(existsSync(join(repo, "pwned"))).toBe(false);
			expect(existsSync(join(dir, "pwned"))).toBe(false);
			expect(readFileSync(gitLog, "utf8")).toContain(`refs/tags/${HOSTILE_TAG}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
