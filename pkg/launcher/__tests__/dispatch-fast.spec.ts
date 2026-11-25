import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeFast } from "../../skills-cli/src/completion/fast";
import { fenceEnv } from "../../skills-cli/__tests__/fence-env";
import { chunkBaseName, cleanupTraces, run, traceChunks } from "./bundle-fixtures";

const home = mkdtempSync(join(tmpdir(), "dg-fast-home-"));
const env = { ...fenceEnv(), HOME: home, DG_HOME: join(home, "dg") };

function loadedFlat(args: string[]): { stdout: string; exitCode: number; loaded: string[] } {
	const { entry, sentinels } = traceChunks(/^chunks\/flat$/);
	const result = run(process.execPath, entry, args, env);
	const loaded = [...sentinels].filter(([, sentinel]) => existsSync(sentinel)).map(([name]) => chunkBaseName(name));
	return { stdout: result.stdout, exitCode: result.exitCode, loaded };
}

describe("dispatch fast routes", () => {
	afterAll(() => {
		cleanupTraces();
		rmSync(home, { recursive: true, force: true });
	});

	test("completion for a command word prints the completeFast lines, one per line", () => {
		const words = ["stat", "ch"];
		const result = loadedFlat(["__complete", ...words]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(`${completeFast(words).join("\n")}\n`);
		expect(result.loaded).toEqual([]);
	});

	test("completion for a nested command word never loads the flat route tree", () => {
		const result = loadedFlat(["__complete", "credentials", "re"]);
		expect(result.stdout).not.toBe("");
		expect(result.loaded).toEqual([]);
	});

	test("hooks run never loads the flat route tree", () => {
		const result = loadedFlat(["hooks", "run", "no-such-hook"]);
		expect(result.loaded).toEqual([]);
	});

	test("--version never loads the flat route tree", () => {
		const result = loadedFlat(["--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.loaded).toEqual([]);
	});

	test("completion for the first word still lists the agent and daemon groups", () => {
		const result = loadedFlat(["__complete", "ag"]);
		expect(result.stdout).toContain("agent\t");
	});

	test("completion for an agent command falls through to the full program", () => {
		const result = loadedFlat(["__complete", "agent", "sen"]);
		expect(result.stdout).toContain("send");
	});
});
