/**
 * Executed smoke test: the CLI actually runs and registers the commands the
 * skills invoke. Runs the source entrypoint via bun (the compiled binary isn't
 * present in CI), which exercises the same command graph the release compiles.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function runCli(
	args: string[],
	env: Record<string, string | undefined> = {},
	stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", ENTRY, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
		env: { ...process.env, ...env },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
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
			"jot",
			"bg",
			"sniff",
			"doctor",
			"db",
			"erd",
			"test-live",
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

	test("jot is registered and its help lists every subcommand", async () => {
		const { code, out } = await runCli(["jot", "--help"]);
		expect(code).toBe(0);
		for (const verb of [
			"add",
			"ls",
			"read",
			"kind",
			"done",
			"kick",
			"kick-list",
			"kick-take",
		])
			expectListed(out, verb);
	});

	test("jot add and ls run a real note round trip in isolated roots", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-jot-smoke-"));
		try {
			const env = {
				HOME: root,
				AI_SCRATCH_DIR: join(root, "scratch"),
				AI_STATE_DIR: join(root, "state"),
			};
			const added = await runCli(["jot", "add"], env, "# smoke note\n");
			expect(added.code).toBe(0);
			expect(added.out.trim().startsWith(join(root, "scratch", "jot"))).toBe(true);
			const listed = await runCli(["jot", "ls", "-n"], env);
			expect(listed.code).toBe(0);
			expect(listed.out).toMatch(/^note\t0m\tjot-[a-z]+-[a-z]+\tsmoke note\n$/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("sniff --help documents the path argument without scanning", async () => {
		const { code, out } = await runCli(["sniff", "--help"]);
		expect(code).toBe(0);
		expect(out).toContain("sniff");
		expect(out.toLowerCase()).toContain("usage");
		expect(() => JSON.parse(out)).toThrow();
	});

	test("sniff lists secret names from a disposable tree and never their values", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-sniff-smoke-"));
		try {
			const fake = "fake-smoke-secret-5d2c9a";
			const tree = join(root, "app");
			mkdirSync(tree);
			writeFileSync(
				join(tree, ".env"),
				`SMOKE_API_TOKEN=${fake}\nSMOKE_HOST=h\n`,
			);
			const env = { HOME: root };
			const ran = await runCli(["sniff", tree], env);
			expect(ran.code).toBe(0);
			expect(ran.out).not.toContain(fake);
			expect(ran.err).not.toContain(fake);
			const report = JSON.parse(ran.out) as {
				requirements: { type: string; name: string }[];
			};
			expect(
				report.requirements.map((row) => `${row.type}:${row.name}`).sort(),
			).toEqual(["CONFIG:SMOKE_HOST", "SECRET:SMOKE_API_TOKEN"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("sniff reports an empty inventory with 0 and a missing path with 1", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-sniff-smoke-"));
		try {
			const empty = await runCli(["sniff", root], { HOME: root });
			expect(empty.code).toBe(0);
			expect(JSON.parse(empty.out).total).toBe(0);
			const ran = await runCli(["sniff", join(root, "absent")], { HOME: root });
			expect(ran.code).toBe(1);
			expect(ran.out).toBe("");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("bg is registered and its help lists every job verb", async () => {
		const { code, out } = await runCli(["bg", "--help"]);
		expect(code).toBe(0);
		for (const verb of ["run", "list", "prune", "status", "cancel", "update"])
			expectListed(out, verb);
	});

	test("bg run, list and prune run a real detached job in isolated roots", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-bg-smoke-"));
		try {
			const env = {
				HOME: root,
				AI_SCRATCH_DIR: join(root, "scratch"),
				AI_STATE_DIR: join(root, "state"),
			};
			const started = await runCli(["bg", "run", "echo smoke", "--cwd", root], env);
			expect(started.code).toBe(0);
			const job = JSON.parse(started.out) as { id: string; logFile: string; state: string };
			expect(job.state).toBe("running");
			expect(job.logFile.startsWith(join(root, "state"))).toBe(true);
			let status = { state: "running" };
			for (let i = 0; i < 200 && status.state === "running"; i++) {
				await Bun.sleep(25);
				status = JSON.parse((await runCli(["bg", "status", job.id], env)).out);
			}
			expect(status).toMatchObject({ state: "done", exitCode: 0 });
			const listed = JSON.parse((await runCli(["bg", "list"], env)).out) as { jobs: { id: string }[] };
			expect(listed.jobs.map((value) => value.id)).toEqual([job.id]);
			const pruned = JSON.parse((await runCli(["bg", "prune", "--cwd", root], env)).out);
			expect(pruned.removed).toEqual([job.id]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

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

	test("doctor --help documents --json and selected items without running a check", async () => {
		const home = mkdtempSync(join(tmpdir(), "dg-doctor-smoke-"));
		try {
			const { code, out } = await runCli(["doctor", "--help"], { HOME: home });
			expect(code).toBe(0);
			expect(out).toContain("--json");
			expect(out).toContain("item");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("doctor exits 2 for an unknown item", async () => {
		const home = mkdtempSync(join(tmpdir(), "dg-doctor-smoke-"));
		try {
			const { code } = await runCli(["doctor", "no-such-item"], { HOME: home });
			expect(code).toBe(2);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("doctor --json prints a report for jot from an isolated home", async () => {
		const home = mkdtempSync(join(tmpdir(), "dg-doctor-smoke-"));
		try {
			mkdirSync(join(home, "scratch"), { mode: 0o700 });
			mkdirSync(join(home, "state"), { mode: 0o700 });
			const { code, out } = await runCli(["doctor", "jot", "--json"], {
				HOME: home,
				AI_SCRATCH_DIR: join(home, "scratch"),
				AI_STATE_DIR: join(home, "state"),
			});
			expect([0, 1]).toContain(code);
			const report = JSON.parse(out) as {
				items: { item: string; checks: unknown[] }[];
				ok: boolean;
			};
			expect(report.items.some((entry) => entry.item === "jot")).toBe(true);
			expect(report.ok).toBe(code === 0);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
