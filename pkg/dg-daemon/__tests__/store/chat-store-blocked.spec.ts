import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import { blockedText, ensureLayout, type LayoutResult } from "@dg/common/node/layout";
import { ChatStore } from "../../src/store";
import { FILE_ONLY_SEAMS } from "../utils/daemon-harness";

const posix = describe.skipIf(process.platform === "win32");

let home: string;
let paths: DgPaths;
let lines: string[];

const log = (line: string): void => {
	lines.push(line);
};

function put(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

const legacyAt = (...parts: string[]): string => join(paths.legacyHome, ...parts);

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-chat-store-blocked-"));
	paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
	lines = [];
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

async function openOrNull(): Promise<ChatStore | undefined> {
	const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	store.close();
	return store;
}

posix("ChatStore.open blocked contract", () => {
	test("throws the kept text and creates no daemon.db after a run that blocked daemon as live-writer", async () => {
		put(legacyAt("daemon", "daemon.db"), "legacy bytes");
		put(legacyAt("daemon", "daemon.pid"), JSON.stringify({ pid: process.pid }));
		const result = await ensureLayout(paths, { log });
		const blocked = result.daemon;
		expect(blocked).toMatchObject({ kind: "blocked", reason: "live-writer" });

		const opened = await ChatStore.open(paths, FILE_ONLY_SEAMS).then(
			(store) => {
				store.close();
				return undefined;
			},
			(error: unknown) => error,
		);

		expect(opened).toBeInstanceOf(DgCliError);
		expect((opened as Error).message).toBe(
			`dg: kept ${legacyAt("daemon")}; a process that writes it is running. Stop it, then run dg-skills install again`,
		);
		expect((opened as Error).message).toBe(blockedText(blocked as Parameters<typeof blockedText>[0]));
		expect(existsSync(paths.dbPath)).toBe(false);
		expect(existsSync(paths.daemonDir)).toBe(false);
	});

	test("throws the has-not-moved text and creates no file on a WeakMap miss with an unmoved legacy daemon", async () => {
		put(legacyAt("daemon", "daemon.db"), "legacy bytes");

		const opened = await ChatStore.open(paths, FILE_ONLY_SEAMS).then(
			(store) => {
				store.close();
				return undefined;
			},
			(error: unknown) => error,
		);

		expect(opened).toBeInstanceOf(DgCliError);
		expect((opened as Error).message).toBe(
			`dg: ${legacyAt("daemon")} has not moved to ${paths.daemonDir}; run dg-skills install`,
		);
		expect(existsSync(paths.dbPath)).toBe(false);
		expect(existsSync(paths.daemonDir)).toBe(false);
	});

	test("throws the kept text for a layout result that blocked daemon through the load seam", async () => {
		const from = legacyAt("daemon");
		const outcome = { kind: "blocked", reason: "live-writer", from, to: paths.daemonDir, fix: "" } as const;
		const fix = blockedText(outcome);
		await ensureLayout(paths, {
			log,
			readdir: () => ["daemon"],
			load: async () =>
				({
					snapshot: () => ({}),
					planLayout: () => ({}),
					mutates: () => false,
					applyLayout: () => ({ daemon: { ...outcome, fix } }) as unknown as LayoutResult,
				}) as never,
		});

		await expect(ChatStore.open(paths, FILE_ONLY_SEAMS)).rejects.toThrow(fix);

		expect(existsSync(paths.dbPath)).toBe(false);
	});

	test("opens when the daemon moved or nothing is left to move", async () => {
		await ensureLayout(paths, { log });

		const store = await openOrNull();

		expect(store).toBeDefined();
		expect(existsSync(paths.dbPath)).toBe(true);
	});
});
