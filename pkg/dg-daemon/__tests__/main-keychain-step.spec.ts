import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "utils", "main-keychain-runner.ts");
let tempHome: string;
let savedDgHome: string | undefined;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "dg-main-keychain-"));
	savedDgHome = process.env.DG_HOME;
	process.env.DG_HOME = join(tempHome, ".dg");
});

afterEach(() => {
	if (savedDgHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = savedDgHome;
	rmSync(tempHome, { recursive: true, force: true });
});

async function runMain(command: string, extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; calls: string[]; home: string; dgHome: string }> {
	const { DG_KEY_SOURCE: _omitted, ...inherited } = process.env;
	const child = Bun.spawn([process.execPath, "run", runner, command], {
		env: { ...inherited, HOME: tempHome, USERPROFILE: tempHome, DG_HOME: join(tempHome, ".dg"), ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	expect(code).toBe(0);
	return JSON.parse(stdout);
}

describe("dg-daemon main keychain step composition", () => {
	it("runs the child under the temp home", async () => {
		const { home, dgHome } = await runMain("status");

		expect(home).toBe(tempHome);
		expect(dgHome).toBe(join(tempHome, ".dg"));
	});

	it("never touches the keychain for status", async () => {
		const { calls } = await runMain("status");

		expect(calls).toEqual([]);
	});

	it("runs the keychain step for serve", async () => {
		const { calls } = await runMain("serve");

		expect(calls.filter((call) => call === "lookup").length).toBeGreaterThan(0);
	});

	it("does not touch the keychain for serve when DG_KEY_SOURCE is file", async () => {
		const { calls } = await runMain("serve", { DG_KEY_SOURCE: "file" });

		expect(calls).toEqual([]);
	});
});
