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
		for (const cmd of ["install", "batch-open", "launch", "demo", "rerun"]) {
			expect(out).toContain(cmd);
		}
	});

	test("install --help documents extension + CLI setup", async () => {
		const { code, out } = await runCli(["install", "--help"]);
		expect(code).toBe(0);
		expect(out.toLowerCase()).toContain("extension");
	});
});
