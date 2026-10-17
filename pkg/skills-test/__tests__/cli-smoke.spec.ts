/**
 * Executed smoke test: the CLI actually runs and registers the commands the
 * skills invoke. Runs the source entrypoint via bun (the compiled binary isn't
 * present in CI), which exercises the same command graph the release compiles.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ENTRY = join(
	import.meta.dir,
	"..",
	"..",
	"skills-cli",
	"src",
	"index.ts",
);

async function runCli(args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["bun", ENTRY, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	return { code, out };
}

describe("dg-skills CLI", () => {
	test("--help exits 0 and lists every command the skills use", async () => {
		const { code, out } = await runCli(["--help"]);
		expect(code).toBe(0);
		for (const cmd of ["install", "batch-open", "launch", "demo", "rerun", "channel-review", "stash", "clipboard-image", "vcs-provider"]) {
			expect(out).toContain(cmd);
		}
	});

	test("stash --help documents all storage scopes without starting a service", async () => {
		const { code, out } = await runCli(["stash", "--help"]);
		expect(code).toBe(0);
		for (const flag of ["--scratch", "--state", "--agents", "--main", "--global", "--unique", "--root", "--dir"]) {
			expect(out).toContain(flag);
		}
	});

	test("clipboard-image --help documents native capture without reading the clipboard", async () => {
		const { code, out } = await runCli(["clipboard-image", "--help"]);
		expect(code).toBe(0);
		expect(out).toContain("--scratch");
	});

	test("vcs-provider --help lists the complete provider command inventory", async () => {
		const { code, out } = await runCli(["vcs-provider", "--help"]);
		expect(code).toBe(0);
		for (const command of ["detect", "capabilities", "auth", "list-prs", "list-issues", "view-issue", "view-pr", "list-threads", "create-pr", "merged-pr-for-branch"]) {
			expect(out).toContain(command);
		}
	});

	test("install --help documents extension + CLI setup", async () => {
		const { code, out } = await runCli(["install", "--help"]);
		expect(code).toBe(0);
		expect(out.toLowerCase()).toContain("extension");
	});

	test("channel-review --help lists its subcommands", async () => {
		const { code, out } = await runCli(["channel-review", "--help"]);
		expect(code).toBe(0);
		for (const cmd of ["start", "stop", "status", "logs", "run", "env", "emojis"]) {
			expect(out).toContain(cmd);
		}
	});

	test("channel-review logs --help lists --env, --lines, and --follow", async () => {
		const { code, out } = await runCli(["channel-review", "logs", "--help"]);
		expect(code).toBe(0);
		for (const flag of ["--env", "--lines", "--follow"]) {
			expect(out).toContain(flag);
		}
	});

	test("channel-review emojis --help lists capture, set, and show", async () => {
		const { code, out } = await runCli(["channel-review", "emojis", "--help"]);
		expect(code).toBe(0);
		for (const cmd of ["capture", "set", "show"]) {
			expect(out).toContain(cmd);
		}
	});
});
