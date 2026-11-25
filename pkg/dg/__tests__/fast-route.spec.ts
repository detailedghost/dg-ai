import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS } from "../../skills-cli/src/hooks/manifest";
import { fastRoute } from "../src/fast-route";

setDefaultTimeout(60_000);

const FAST_MODULE = join(import.meta.dir, "..", "src", "fast-route.ts");
const FULL_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const FAST_DRIVER = `import { exitAfterDrain } from "@dg/common/async";
import { normalizeDgHome } from "@dg/common/node/dg-paths";
import { runFastRoute } from ${JSON.stringify(FAST_MODULE)};
normalizeDgHome();
await exitAfterDrain(await runFastRoute(process.argv.slice(1)));`;

describe("fastRoute", () => {
	test.each([
		[["hooks", "run", "pr-confirm"], "hooks"],
		[["hooks", "run"], "hooks"],
		[["__complete", "hooks"], "completion"],
		[["__complete"], "completion"],
		[["--version"], "version"],
	] as const)("routes %p to %p", (argv, expected) => {
		expect(fastRoute([...argv])).toBe(expected);
	});

	test.each([
		[[]],
		[["hooks"]],
		[["hooks", "list"]],
		[["hooks", "status", "--json"]],
		[["doctor"]],
		[["completion", "bash"]],
		[["help"]],
		[["skills", "hooks", "run", "x"]],
	] as const)("leaves %p to the full tree", (argv) => {
		expect(fastRoute([...argv])).toBeUndefined();
	});

	test("does not mutate its argument", () => {
		const argv = ["hooks", "run", "format"];
		fastRoute(argv);
		expect(argv).toEqual(["hooks", "run", "format"]);
	});
});

interface Result {
	stdout: string;
	stderr: string;
	exitCode: number;
}

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function world() {
	const root = mkdtempSync(join(tmpdir(), "dg-fast-parity-"));
	roots.push(root);
	mkdirSync(join(root, "home"));
	return {
		root,
		env: {
			...process.env,
			DG_HOME: join(root, ".dg"),
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
			AI_SCRATCH_DIR: join(root, "scratch"),
			AI_STATE_DIR: join(root, "state"),
			CLAUDE_CODE_SESSION_ID: "parity",
		},
	};
}

function run(argv: string[], stdin: string, env: Record<string, string | undefined>): Result {
	const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: Buffer.from(stdin), env });
	return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? -1 };
}

const EVENTS: Record<string, unknown> = {
	spelling: { tool_name: "Write", tool_input: { file_path: "a.md", content: "the colour of the neighbour" } },
	"pr-prose": { tool_name: "Bash", tool_input: { command: "gh pr create --title t --body 'x'" } },
	"pr-confirm": { tool_name: "Bash", tool_input: { command: "gh pr create --title t --body b" } },
};

describe("hooks run parity", () => {
	for (const hook of HOOKS) {
		test(`${hook.id} gives the same output and exit code through the fast route and the full tree`, () => {
			const { root, env } = world();
			const message = join(root, "COMMIT_MSG");
			writeFileSync(message, "feat(x): y\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
			const args = hook.event === "commit-msg" ? ["hooks", "run", hook.id, message] : ["hooks", "run", hook.id];
			const stdin = JSON.stringify(EVENTS[hook.id] ?? { tool_name: "Bash", tool_input: { command: "ls" } });
			const fast = run([process.execPath, "-e", FAST_DRIVER, ...args], stdin, env);
			const full = run([process.execPath, FULL_ENTRY, ...args], stdin, env);
			expect(fast).toEqual(full);
		});
	}

	test("an unknown hook id fails the same way through both routes", () => {
		const { env } = world();
		const args = ["hooks", "run", "no-such-hook"];
		const fast = run([process.execPath, "-e", FAST_DRIVER, ...args], "{}", env);
		const full = run([process.execPath, FULL_ENTRY, ...args], "{}", env);
		expect(fast.exitCode).toBe(1);
		expect(fast).toEqual(full);
	});

	test("pr-confirm asks for confirmation through the fast route", () => {
		const { env } = world();
		const fast = run(
			[process.execPath, "-e", FAST_DRIVER, "hooks", "run", "pr-confirm"],
			JSON.stringify(EVENTS["pr-confirm"]),
			env,
		);
		expect(fast.exitCode).toBe(0);
		expect(JSON.parse(fast.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
	});
});
