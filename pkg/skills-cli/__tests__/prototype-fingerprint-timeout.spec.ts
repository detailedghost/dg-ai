import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acceptanceHook, FINGERPRINT_TIMEOUT_MS } from "../src/prototype/accepted";
import { sentinelPaths } from "../src/prototype/paths";
import { confirm, type WaitResult, wait, waitExitCode, writeSentinel } from "../src/prototype/sentinels";
import type { Capturer } from "../src/verify/capture-model";
import { makeTempDir } from "./git-repo-fixtures";

let root: string;

beforeEach(() => {
	root = makeTempDir("dg-prototype-fp-timeout-");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const never = <T>() => new Promise<T>(() => undefined);

function hangingCapturer(closed: { count: number }): () => Promise<Capturer> {
	return async () => ({
		shot: () => never(),
		async close() {
			closed.count += 1;
		},
	});
}

function picked(dir: string): void {
	const paths = sentinelPaths(dir);
	confirm(paths, "A", "make it wider", "browser");
	writeSentinel(paths.url, "http://127.0.0.1:18416/ScheduleDoctor/ViewSchedule?variant=A\n");
}

describe("bounded fingerprint step", () => {
	test("the bound is between 30 and 60 seconds", () => {
		expect(FINGERPRINT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
		expect(FINGERPRINT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
	});

	test("wait announces the pick before a hanging fingerprint step, then exits 0 within the bound", async () => {
		const dir = join(root, "schedule-calendar");
		picked(dir);
		const closed = { count: 0 };
		const announced: WaitResult[] = [];
		const started = Date.now();
		const result = await wait(
			sentinelPaths(dir),
			1,
			acceptanceHook(
				{ dir, name: "schedule-calendar", chain: "schedule-calendar" },
				{ open: hangingCapturer(closed), timeoutMs: 300 },
			),
			(claimed) => announced.push(claimed),
		);
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(announced).toEqual([{ status: "ok", variant: "A", notes: "make it wider" }]);
		expect(waitExitCode(result)).toBe(0);
		expect(closed.count).toBeGreaterThan(0);
		const record = JSON.parse(readFileSync(join(dir, "accepted.json"), "utf8")) as {
			variant: string;
			fingerprint: unknown;
			skipped: string;
		};
		expect(record.variant).toBe("A");
		expect(record.fingerprint).toBeNull();
		expect(record.skipped).toStartWith("timed out after 0.3s");
		expect(existsSync(join(dir, ".selection"))).toBe(false);
	});

	test("a browser launch that hangs is bounded the same way", async () => {
		const dir = join(root, "launch");
		picked(dir);
		const result = await wait(
			sentinelPaths(dir),
			1,
			acceptanceHook({ dir, name: "launch", chain: "launch" }, { open: () => never(), timeoutMs: 300 }),
			() => undefined,
		);
		expect(waitExitCode(result)).toBe(0);
		const record = JSON.parse(readFileSync(join(dir, "accepted.json"), "utf8")) as { skipped: string };
		expect(record.skipped).toStartWith("timed out after 0.3s");
	});

	test("a browser that finishes launching after the bound is closed, not leaked", async () => {
		const dir = join(root, "late");
		picked(dir);
		const closed = { count: 0 };
		let launched: (capturer: Capturer) => void = () => undefined;
		const late = new Promise<Capturer>((resolve) => {
			launched = resolve;
		});
		await wait(
			sentinelPaths(dir),
			1,
			acceptanceHook({ dir, name: "late", chain: "late" }, { open: () => late, timeoutMs: 100 }),
		);
		launched(await hangingCapturer(closed)());
		for (let i = 0; i < 100 && closed.count === 0; i++) await Bun.sleep(20);
		expect(closed.count).toBe(1);
	});

	test("the announcement happens before the approve hook starts", async () => {
		const dir = join(root, "order");
		picked(dir);
		const events: string[] = [];
		await wait(
			sentinelPaths(dir),
			1,
			async () => {
				events.push("hook");
				return undefined;
			},
			() => events.push("announce"),
		);
		expect(events).toEqual(["announce", "hook"]);
	});

	test("a timeout with no pick is announced too", async () => {
		const announced: WaitResult[] = [];
		await wait(sentinelPaths(join(root, "empty")), 0, undefined, (claimed) => announced.push(claimed));
		expect(announced).toEqual([{ status: "timeout" }]);
	});
});
