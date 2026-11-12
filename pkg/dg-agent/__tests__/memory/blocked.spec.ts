import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import { blockedText, ensureLayout, type LayoutResult } from "@dg/common/node/layout";
import { MemoryStore } from "../../src/memory/store";

const posix = describe.skipIf(process.platform === "win32");

let home: string;
let paths: DgPaths;

function put(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

const legacyAt = (...parts: string[]): string => join(paths.legacyHome, ...parts);

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-memory-blocked-"));
	paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function attempt(): unknown {
	try {
		MemoryStore.open(paths).close();
		return undefined;
	} catch (error) {
		return error;
	}
}

posix("MemoryStore.open blocked contract", () => {
	test("throws the kept text and creates no memory.db or agents folder for a layout result that blocked memory", async () => {
		const from = legacyAt("agents", "memory.db");
		const outcome = { kind: "blocked", reason: "live-writer", from, to: paths.memoryDbPath, fix: "" } as const;
		const fix = blockedText(outcome);
		await ensureLayout(paths, {
			log: () => {},
			readdir: () => ["agents"],
			load: async () =>
				({
					snapshot: () => ({}),
					planLayout: () => ({}),
					mutates: () => false,
					applyLayout: () => ({ memory: { ...outcome, fix } }) as unknown as LayoutResult,
				}) as never,
		});

		const error = attempt();

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toBe(fix);
		expect(existsSync(paths.memoryDbPath)).toBe(false);
		expect(existsSync(paths.agentsDir)).toBe(false);
	});

	test("throws the has-not-moved text and creates no file on a WeakMap miss with an unmoved legacy memory.db", () => {
		put(legacyAt("agents", "memory.db"), "legacy bytes");

		const error = attempt();

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toBe(
			`dg: ${legacyAt("agents", "memory.db")} has not moved to ${paths.memoryDbPath}; run dg-skills install`,
		);
		expect(existsSync(paths.memoryDbPath)).toBe(false);
		expect(existsSync(paths.agentsDir)).toBe(false);
	});

	test("opens when nothing is left to move", async () => {
		await ensureLayout(paths, { log: () => {} });

		expect(attempt()).toBeUndefined();
		expect(existsSync(paths.memoryDbPath)).toBe(true);
	});
});
