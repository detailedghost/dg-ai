import { afterEach, describe, expect, test } from "bun:test";
import { createPrWatcher } from "../src/automation/pr-watch";
import type { PrCheck, PrStatus } from "../src/automation/types";
import { createEngineHarness } from "./support/fakes";

const URL = "https://github.com/example-org/app/pull/9";
const MINUTE = 60_000;

const harnesses: ReturnType<typeof createEngineHarness>[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

const pass = (name: string): PrCheck => ({ name, done: true, ok: true });
const fail = (name: string): PrCheck => ({ name, done: true, ok: false });
const pending = (name: string): PrCheck => ({ name, done: false, ok: false });

function setup(status: Partial<PrStatus> = {}, deps: Record<string, unknown> = {}) {
	const h = createEngineHarness({ configExtra: { deps: { ciTimeoutMinutes: 30, ...deps } } });
	harnesses.push(h);
	const current: PrStatus = { state: "OPEN", isDraft: true, checks: [pass("build")], ...status };
	const ready: string[] = [];
	const dms: string[] = [];
	const control = { status: current, error: undefined as Error | undefined };
	const watcher = createPrWatcher({
		state: h.state,
		config: h.config,
		notify: async (text, link) => {
			dms.push(link ? `${text} ${link}` : text);
		},
		repos: {
			prStatus: async () => {
				if (control.error) throw control.error;
				return control.status;
			},
			markReady: async (url) => {
				ready.push(url);
			},
		},
		clock: h.clock,
		log: h.log,
	});
	h.state.watchPr(URL, { repo: "github.com/example-org/app", kind: "deps" });
	return { h, watcher, control, ready, dms };
}

describe("pr watcher", () => {
	test("marks the PR ready, sends a DM and stops watching when all checks pass", async () => {
		const { h, watcher, ready, dms } = setup({ checks: [pass("build"), pass("lint")] });
		await watcher.tick();
		expect(ready).toEqual([URL]);
		expect(dms).toEqual([`Deps upgrade ready: ${URL}`]);
		expect(h.state.get().prWatch).toEqual({});
	});

	test("keeps watching while a check is still running", async () => {
		const { h, watcher, ready, dms } = setup({ checks: [pass("build"), pending("e2e")] });
		await watcher.tick();
		expect(ready).toEqual([]);
		expect(dms).toEqual([]);
		expect(Object.keys(h.state.get().prWatch)).toEqual([URL]);
	});

	test("names the failing checks and stops watching", async () => {
		const { h, watcher, ready, dms } = setup({ checks: [fail("e2e"), pass("build"), fail("lint")] });
		await watcher.tick();
		expect(ready).toEqual([]);
		expect(dms).toEqual([`CI failed on ${URL}: e2e, lint`]);
		expect(h.state.get().prWatch).toEqual({});
	});

	test("reports a failure even while other checks still run", async () => {
		const { watcher, dms } = setup({ checks: [fail("e2e"), pending("lint")] });
		await watcher.tick();
		expect(dms).toEqual([`CI failed on ${URL}: e2e`]);
	});

	test("times out when checks stay pending past the CI timeout", async () => {
		const { h, watcher, ready, dms } = setup({ checks: [pending("e2e")] });
		h.clock.advance(29 * MINUTE);
		await watcher.tick();
		expect(dms).toEqual([]);
		h.clock.advance(2 * MINUTE);
		await watcher.tick();
		expect(ready).toEqual([]);
		expect(dms).toHaveLength(1);
		expect(dms[0]).toContain("30 minutes");
		expect(dms[0]).toContain(URL);
		expect(h.state.get().prWatch).toEqual({});
	});

	test("stops watching a merged or closed PR without a DM", async () => {
		for (const state of ["MERGED", "CLOSED"] as const) {
			const { h, watcher, dms, ready } = setup({ state });
			await watcher.tick();
			expect(dms).toEqual([]);
			expect(ready).toEqual([]);
			expect(h.state.get().prWatch).toEqual({});
		}
	});

	test("sends a ready DM when someone already marked the PR ready", async () => {
		const { h, watcher, ready, dms } = setup({ isDraft: false, checks: [pending("e2e")] });
		await watcher.tick();
		expect(ready).toEqual([]);
		expect(dms).toEqual([`Deps upgrade ready: ${URL}`]);
		expect(h.state.get().prWatch).toEqual({});
	});

	test("waits for checks to appear, then treats a repo without CI as green", async () => {
		const { h, watcher, ready, dms } = setup({ checks: [] });
		h.clock.advance(4 * MINUTE);
		await watcher.tick();
		expect(ready).toEqual([]);
		expect(Object.keys(h.state.get().prWatch)).toEqual([URL]);
		h.clock.advance(MINUTE);
		await watcher.tick();
		expect(ready).toEqual([URL]);
		expect(dms).toEqual([`Deps upgrade ready: ${URL}`]);
	});

	test("keeps the watch and logs when gh fails", async () => {
		const { h, watcher, control, dms } = setup();
		control.error = new Error("gh down");
		await watcher.tick();
		expect(dms).toEqual([]);
		expect(Object.keys(h.state.get().prWatch)).toEqual([URL]);
	});
});
