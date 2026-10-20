/**
 * Executed smoke test: the CLI actually runs and registers the commands the
 * skills invoke. Runs the source entrypoint via bun (the compiled binary isn't
 * present in CI), which exercises the same command graph the release compiles.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function expectListed(out: string, verb: string): void {
	expect(out).toMatch(new RegExp(`^  ${verb}(?: |$)`, "m"));
}

describe("dg-skills CLI", () => {
	test("--help exits 0 and lists every command the skills use", async () => {
		const { code, out } = await runCli(["--help"]);
		expect(code).toBe(0);
		for (const cmd of [
			"install",
			"batch-open",
			"launch",
			"demo",
			"rerun",
			"channel-review",
			"stash",
			"clipboard-image",
			"vcs-provider",
			"proxy",
			"address",
			"thrash",
			"chain",
			"file",
			"deps-upgrade",
			"meaningful",
			"catchup",
			"worktree",
			"spec",
			"monolith",
			"viz",
		]) {
			expectListed(out, cmd);
		}
	});

	test("stash --help documents all storage scopes without starting a service", async () => {
		const { code, out } = await runCli(["stash", "--help"]);
		expect(code).toBe(0);
		for (const flag of [
			"--scratch",
			"--state",
			"--agents",
			"--main",
			"--global",
			"--unique",
			"--root",
			"--dir",
		]) {
			expect(out).toContain(flag);
		}
	});

	test("worktree --help documents create, list, remove and prune without touching a repository", async () => {
		const { code, out } = await runCli(["worktree", "--help"]);
		expect(code).toBe(0);
		for (const verb of ["create", "list", "remove", "prune"])
			expect(out).toContain(verb);
	});

	test("spec is registered and its help lists every subcommand", async () => {
		const { code, out } = await runCli(["spec", "--help"]);
		expect(code).toBe(0);
		for (const verb of [
			"perms",
			"perms-batch",
			"next-nnn",
			"roundtable",
			"review",
			"slice",
			"context",
			"brief",
			"diff-bundle",
			"audit",
			"ready",
			"pr-body",
			"issues",
			"slugify",
			"resolve-path",
			"validate",
			"get",
			"set",
			"append-section",
			"roster",
			"scaffold",
			"lint-waves",
			"prototype-ref",
		])
			expect(out).toContain(verb);
	});

	test("monolith is registered and its help lists the helper verbs and the generator", async () => {
		const { code, out } = await runCli(["monolith", "--help"]);
		expect(code).toBe(0);
		for (const verb of [
			"bootstrap",
			"list-terms",
			"list-sections",
			"validate",
			"prune",
			"patch-pointer",
			"patch-agents-md",
			"cap-report",
			"split",
			"detect-conflicts",
			"apply-conflict-resolution",
			"worktree-gen",
		])
			expect(out).toContain(verb);
	});

	test("monolith bootstrap runs a real operation through the source entry point", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-monolith-smoke-"));
		try {
			const { code, out } = await runCli(["monolith", "bootstrap", dir]);
			expect(code).toBe(0);
			expect(out).toBe(
				`APPEND_MODE=0\nMONOLITH_PATH=${join(dir, ".agents", "monolith.md")}\nLIGHT_MODE=0\n`,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("viz --help lists every verb without starting a viewer", async () => {
		const { code, out } = await runCli(["viz", "--help"]);
		expect(code).toBe(0);
		for (const verb of [
			"render",
			"doctor",
			"get",
			"wait",
			"review-wait",
			"merge",
			"phase",
			"next-steps",
			"annotate",
			"review",
			"link",
			"track",
			"list",
			"dismiss",
			"clean",
			"stop",
		])
			expect(out).toContain(verb);
		expect(out).not.toContain("viz-cli");
	});

	test("clipboard-image --help documents native capture without reading the clipboard", async () => {
		const { code, out } = await runCli(["clipboard-image", "--help"]);
		expect(code).toBe(0);
		expect(out).toContain("--scratch");
	});

	test("vcs-provider --help lists the complete provider command inventory", async () => {
		const { code, out } = await runCli(["vcs-provider", "--help"]);
		expect(code).toBe(0);
		for (const command of [
			"detect",
			"capabilities",
			"auth",
			"list-prs",
			"list-issues",
			"view-issue",
			"view-pr",
			"list-threads",
			"create-pr",
			"merged-pr-for-branch",
		]) {
			expect(out).toContain(command);
		}
	});

	test("address --help lists every verb without accessing a provider", async () => {
		const { code, out } = await runCli(["address", "--help"]);
		expect(code).toBe(0);
		for (const command of [
			"probe",
			"view-pr",
			"gather",
			"gather-unresolved",
			"check-bot-review",
			"gather-ci-failures",
			"reply",
			"resolve",
			"resolve-silent",
			"resolve-with-reply",
			"commit-push",
			"batch-close",
			"check-copilot",
			"request-copilot",
			"fetch-copilot-review",
			"count-copilot-reviews",
			"verify-copilot-engaged",
			"check-no-findings",
			"await-copilot-review",
		]) {
			expectListed(out, command);
		}
	});

	test("thrash --help lists review operations without accessing a provider", async () => {
		const { code, out } = await runCli(["thrash", "--help"]);
		expect(code).toBe(0);
		for (const command of ["diff", "compile", "post", "stack", "tally"]) {
			expect(out).toContain(command);
		}
	});

	test("deps-upgrade --help lists its complete operation inventory", async () => {
		const { code, out } = await runCli(["deps-upgrade", "--help"]);
		expect(code).toBe(0);
		for (const verb of [
			"prepare",
			"list-prs",
			"pr-body",
			"audit",
			"install",
			"audit-fix",
			"bump-dep",
			"bump-action",
			"commit",
			"status",
			"reset-deps",
			"close-prs",
			"cooldown",
			"push-pr",
			"ready-when-green",
			"summary",
		]) {
			expectListed(out, verb);
		}
	});

	test("meaningful --help lists history reshaping operations", async () => {
		const { code, out } = await runCli(["meaningful", "--help"]);
		expect(code).toBe(0);
		for (const verb of ["info", "apply-json", "abort"])
			expectListed(out, verb);
	});

	test("catchup --help documents default and disabled pushing", async () => {
		const { code, out } = await runCli(["catchup", "--help"]);
		expect(code).toBe(0);
		for (const flag of ["--push", "--no-push"]) expect(out).toContain(flag);
	});

	test("proxy --help documents backend selection without starting a backend", async () => {
		const { code, out } = await runCli(["proxy", "--help"]);
		expect(code).toBe(0);
		expect(out).toContain("--prompt");
	});

	test("install --help documents extension + CLI setup", async () => {
		const { code, out } = await runCli(["install", "--help"]);
		expect(code).toBe(0);
		expect(out.toLowerCase()).toContain("extension");
	});

	test("channel-review --help lists its subcommands", async () => {
		const { code, out } = await runCli(["channel-review", "--help"]);
		expect(code).toBe(0);
		for (const cmd of [
			"start",
			"stop",
			"status",
			"logs",
			"run",
			"env",
			"emojis",
		]) {
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
