import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsCli } from "../build";

setDefaultTimeout(60_000);

const root = mkdtempSync(join(tmpdir(), "dg-pw-compiled-"));
const cwd = join(root, "external-cwd");
const binary = join(root, "moved-install", "dg-skills");
const entrypoint = join(root, "pw-entry.ts");

beforeAll(async () => {
	for (const directory of [cwd, join(binary, "..")]) mkdirSync(directory, { recursive: true });
	writeFileSync(
		entrypoint,
		`import { Command } from ${JSON.stringify(Bun.resolveSync("commander", import.meta.dir))};
import { registerPw } from ${JSON.stringify(join(import.meta.dir, "../src/commands/pw.ts"))};
import { registerPwCode } from ${JSON.stringify(join(import.meta.dir, "../src/commands/pw-code.ts"))};
const program = new Command().name("dg-skills").enablePositionalOptions();
registerPw(program);
registerPwCode(program);
await program.parseAsync(process.argv);
`,
	);
	await buildSkillsCli({ outfile: binary, entrypoint });
}, 120_000);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string | undefined> = {}) {
	const result = Bun.spawnSync([binary, "pw", ...args], {
		cwd,
		env: { ...env, PATH: "", AI_SCRATCH_DIR: join(root, "scratch"), AI_STATE_DIR: join(root, "state") },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe("pw compiled, relocated, no legacy scripts on PATH", () => {
	test("registers help beyond --help alone: list, close-all and kill-all work with zero sessions", () => {
		const help = run(["--help"]);
		expect(help.code).toBe(0);
		expect(help.out).toContain("pw");
		expect(help.out).toContain("Open the browser");

		const listed = run(["list"]);
		expect(listed.code, listed.err).toBe(0);
		expect(listed.out).toContain("(none open)");

		const closedAll = run(["close-all"]);
		expect(closedAll.code, closedAll.err).toBe(0);
		expect(closedAll.out).toContain("No open browsers.");

		const killedAll = run(["kill-all"]);
		expect(killedAll.code, killedAll.err).toBe(0);
		expect(killedAll.out).toContain("Killed 0 browser session");
	});

	test("pw-code is a separate top-level command, unreachable through pw", () => {
		const moved = run(["run-code", "async (page) => 1"]);
		expect(moved.code).toBe(2);
		expect(moved.err).toContain("run-code moved to pw-code");

		const codeResult = Bun.spawnSync([binary, "pw-code", "async (page) => 1"], {
			cwd,
			env: { PATH: "", AI_SCRATCH_DIR: join(root, "scratch"), AI_STATE_DIR: join(root, "state") },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(codeResult.exitCode).toBe(1);
		expect(codeResult.stderr.toString()).toContain("is not open");
	});
});
