import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { type SystemSeams, resolveDgPaths } from "@dg/common/node/dg-paths";
import { blockedText, ensureLayout, type LayoutResult } from "@dg/common/node/layout";
import { channelReviewPaths } from "../src/paths";
import { createStateStore } from "../src/state";

const posix = describe.skipIf(process.platform === "win32");

let home: string;
let seams: SystemSeams;

function put(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-review-state-blocked-"));
	seams = { platform: process.platform, homeDir: home, env: {} };
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function attempt(): unknown {
	try {
		createStateStore(channelReviewPaths("dev", seams)).close();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe("channelReviewPaths dg field", () => {
	test("carries the memoized DgPaths of its seams", () => {
		const paths = channelReviewPaths("dev", seams);

		expect(paths.dg).toBe(resolveDgPaths(seams));
	});

	test("carries a different object for another home", () => {
		const other = { ...seams, homeDir: join(home, "other") };

		expect(channelReviewPaths("dev", other).dg).not.toBe(channelReviewPaths("dev", seams).dg);
	});
});

posix("createStateStore blocked contract", () => {
	test("throws the kept text and creates no database when a live review daemon blocks channel-review", async () => {
		const dg = resolveDgPaths(seams);
		put(join(dg.legacyHome, "channel-review", "daemon.dev.pid"), JSON.stringify({ pid: process.pid }));
		put(join(dg.legacyHome, "channel-review", "state.dev.json"), "{}");
		const result = await ensureLayout(dg, { log: () => {} });
		const blocked = result["channel-review"];
		expect(blocked).toMatchObject({ kind: "blocked", reason: "live-writer" });

		const error = attempt();

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toBe(blockedText(blocked as Parameters<typeof blockedText>[0]));
		expect((error as Error).message).toContain(`dg: kept ${join(dg.legacyHome, "channel-review")}; a process that writes it is running`);
		expect(existsSync(dg.dbPath)).toBe(false);
	});

	test("throws the kept text for a layout result that blocked channel-review through the load seam", async () => {
		const dg = resolveDgPaths(seams);
		const outcome = {
			kind: "blocked",
			reason: "live-writer",
			from: join(dg.legacyHome, "channel-review"),
			to: join(dg.stateDir, "channel-review"),
			fix: "",
		} as const;
		const fix = blockedText(outcome);
		await ensureLayout(dg, {
			log: () => {},
			readdir: () => ["channel-review"],
			load: async () =>
				({
					snapshot: () => ({}),
					planLayout: () => ({}),
					mutates: () => false,
					applyLayout: () => ({ "channel-review": { ...outcome, fix } }) as unknown as LayoutResult,
				}) as never,
		});

		const error = attempt();

		expect((error as Error).message).toBe(fix);
		expect(existsSync(dg.dbPath)).toBe(false);
	});

	test("throws the daemon has-not-moved text and creates no per-OS daemon.db when only daemon is blocked", async () => {
		const dg = resolveDgPaths(seams);
		put(join(dg.legacyHome, "daemon", "daemon.pid"), JSON.stringify({ pid: process.pid }));
		put(join(dg.legacyHome, "daemon", "daemon.db"), "rows");
		await ensureLayout(dg, { log: () => {} });

		const error = attempt();

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toContain(join(dg.legacyHome, "daemon"));
		expect(existsSync(dg.dbPath)).toBe(false);
	});

	test("opens when nothing is left to move", async () => {
		await ensureLayout(resolveDgPaths(seams), { log: () => {} });

		expect(attempt()).toBeUndefined();
	});
});
