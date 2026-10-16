import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { createStateStore, prKey } from "../src/state";
import { type TempHome, createTempHome } from "./support/fakes";

let home: TempHome;
let path: string;
beforeEach(() => {
	home = createTempHome();
	path = join(home.dir, "state.dev.json");
});
afterEach(() => {
	home.cleanup();
});

const HOUR_MS = 3_600_000;
const GITHUB_URL = "https://github.com/o/r/pull/12";
const OPTIONS = { spice: 4, comment: true, fun: false };

describe("createStateStore", () => {
	test("starts empty when the file does not exist", () => {
		expect(createStateStore(path).get()).toEqual({
			lastEventIds: {},
			current: null,
			handled: {},
			blocked: {},
			issues: {},
			sinks: {},
			fixStarts: [],
			deps: { lastRun: {} },
			prWatch: {},
		});
	});

	test("loads an old state file and fills the automation fields", () => {
		writeFileSync(
			path,
			JSON.stringify({ lastEventIds: { c1: "e1" }, current: null, handled: {}, blocked: {} }),
		);
		const state = createStateStore(path).get();
		expect(state.lastEventIds).toEqual({ c1: "e1" });
		expect(state.issues).toEqual({});
		expect(state.sinks).toEqual({});
		expect(state.fixStarts).toEqual([]);
		expect(state.deps).toEqual({ lastRun: {} });
		expect(state.prWatch).toEqual({});
	});

	test("round-trips issues, sinks, fix starts, deps runs and PR watches", () => {
		const store = createStateStore(path, () => new Date("2026-10-14T12:00:00.000Z"));
		store.setIssue("dd:1", { status: "pr-open", firstSeen: "2026-10-14T11:00:00.000Z", prUrl: GITHUB_URL });
		store.updateSink("datadog", { cursor: "c9", lastPollAt: "2026-10-14T12:00:00.000Z", counts: { polled: 3 } });
		store.updateSink("datadog", { lastError: "boom" });
		store.recordFixStart();
		store.recordDepsRun("github.com/example-org/app", { windowStart: "2026-10-14T02:00:00.000Z", result: "pr-open" });
		store.watchPr(GITHUB_URL, { repo: "github.com/example-org/app", kind: "deps" });
		const reloaded = createStateStore(path).get();
		expect(reloaded.issues["dd:1"]).toEqual({
			status: "pr-open",
			firstSeen: "2026-10-14T11:00:00.000Z",
			prUrl: GITHUB_URL,
			at: "2026-10-14T12:00:00.000Z",
		});
		expect(reloaded.sinks.datadog).toEqual({
			cursor: "c9",
			lastPollAt: "2026-10-14T12:00:00.000Z",
			lastError: "boom",
			counts: { polled: 3 },
		});
		expect(reloaded.fixStarts).toEqual(["2026-10-14T12:00:00.000Z"]);
		expect(reloaded.deps.lastRun["github.com/example-org/app"]?.result).toBe("pr-open");
		expect(reloaded.prWatch[GITHUB_URL]).toEqual({
			repo: "github.com/example-org/app",
			kind: "deps",
			startedAt: "2026-10-14T12:00:00.000Z",
		});
		createStateStore(path).unwatchPr(GITHUB_URL);
		expect(createStateStore(path).get().prWatch).toEqual({});
	});

	test("drops fix starts older than an hour when it records a new one", () => {
		let now = new Date("2026-10-14T12:00:00.000Z");
		const store = createStateStore(path, () => now);
		store.recordFixStart();
		now = new Date("2026-10-14T13:30:00.000Z");
		store.recordFixStart();
		expect(store.get().fixStarts).toEqual(["2026-10-14T13:30:00.000Z"]);
	});

	test.each([
		["issues", { issues: { a: { status: "bogus" } } }],
		["sinks", { sinks: { a: { counts: { x: "1" } } } }],
		["fixStarts", { fixStarts: [1] }],
		["deps", { deps: { lastRun: { a: {} } } }],
		["prWatch", { prWatch: { a: { repo: "r", kind: "other", startedAt: "t" } } }],
	])("rejects a malformed %s field", (_name, body) => {
		writeFileSync(path, JSON.stringify(body));
		expect(() => createStateStore(path)).toThrow(DgCliError);
	});

	test("round-trips lastEventIds, current and handled through disk", () => {
		const store = createStateStore(path);
		const current = {
			messageId: "m1",
			url: GITHUB_URL,
			number: 12,
			startedAt: "2026-10-14T12:00:00.000Z",
			pid: 4242,
		};
		store.setLastEventId("c1", "evt-9");
		store.setCurrent(current);
		store.markHandled("m1", "running");
		const reloaded = createStateStore(path).get();
		expect(reloaded.lastEventIds).toEqual({ c1: "evt-9" });
		expect(reloaded.current).toEqual(current);
		expect(reloaded.handled.m1?.status).toBe("running");
		expect(Number.isFinite(Date.parse(reloaded.handled.m1?.at ?? ""))).toBe(
			true,
		);
	});

	test("clears current with setCurrent(null)", () => {
		const store = createStateStore(path);
		store.setCurrent({
			messageId: "m1",
			url: GITHUB_URL,
			number: 12,
			startedAt: "2026-10-14T12:00:00.000Z",
		});
		store.setCurrent(null);
		expect(createStateStore(path).get().current).toBeNull();
	});

	test("overwrites the status of a handled message", () => {
		const store = createStateStore(path);
		store.markHandled("m1", "pending");
		store.markHandled("m1", "done");
		expect(createStateStore(path).get().handled.m1?.status).toBe("done");
	});

	test("keeps earlier fields when a later mutator runs", () => {
		const store = createStateStore(path);
		store.setLastEventId("c1", "evt-1");
		store.markHandled("m1", "done");
		const reloaded = createStateStore(path).get();
		expect(reloaded.lastEventIds.c1).toBe("evt-1");
		expect(reloaded.handled.m1?.status).toBe("done");
	});

	test("leaves no temp file behind and writes valid JSON", () => {
		const store = createStateStore(path);
		store.setLastEventId("c1", "a");
		store.markHandled("m1", "done");
		store.setLastEventId("c1", "b");
		store.flush();
		expect(readdirSync(home.dir)).toEqual(["state.dev.json"]);
		expect(JSON.parse(readFileSync(path, "utf8")).lastEventIds).toEqual({ c1: "b" });
	});

	test("creates its directory with mode 0700", () => {
		const nested = join(home.dir, "channel-review", "state.dev.json");
		createStateStore(nested).setLastEventId("c1", "a");
		expect(statSync(join(home.dir, "channel-review")).mode & 0o777).toBe(
			0o700,
		);
	});

	test("prunes handled entries older than 24 hours and keeps newer ones", () => {
		const now = new Date("2026-10-14T12:00:00.000Z");
		const at = (ageMs: number): string =>
			new Date(now.getTime() - ageMs).toISOString();
		writeFileSync(
			path,
			JSON.stringify({
				lastEventIds: { c1: "evt" },
				current: null,
				handled: {
					old: { status: "done", at: at(24 * HOUR_MS + 1000) },
					fresh: { status: "done", at: at(23 * HOUR_MS) },
				},
				blocked: {},
			}),
		);
		const store = createStateStore(path);
		store.pruneHandled(now);
		const reloaded = createStateStore(path).get();
		expect(Object.keys(reloaded.handled)).toEqual(["fresh"]);
		expect(reloaded.lastEventIds.c1).toBe("evt");
	});
});

describe("malformed state file", () => {
	const cases: Record<string, unknown> = {
		"a null handled entry": { handled: { m1: null } },
		"an unknown handled status": {
			handled: { m1: { status: "weird", at: "2026-10-14T12:00:00.000Z" } },
		},
		"a current job without startedAt": {
			current: { messageId: "m1", url: GITHUB_URL, number: 12 },
		},
		"a malformed blocked entry": { blocked: { k: "nope" } },
	};
	for (const [name, content] of Object.entries(cases)) {
		test(`throws DgCliError naming the path for ${name}`, () => {
			writeFileSync(path, JSON.stringify(content));
			expect(() => createStateStore(path)).toThrow(path);
			expect(() => createStateStore(path)).toThrow(DgCliError);
		});
	}
});

describe("injected clock", () => {
	test("stamps handled and blocked entries with the clock time", () => {
		const fixed = new Date("2026-10-14T12:00:00.000Z");
		const store = createStateStore(path, () => fixed);
		store.markHandled("m1", "done");
		store.markBlocked(GITHUB_URL, "m1", OPTIONS, "c1");
		expect(store.get().handled.m1?.at).toBe(fixed.toISOString());
		expect(Object.values(store.get().blocked)[0]?.at).toBe(fixed.toISOString());
	});
});

describe("blocked-PR registry", () => {
	test("persists Grok selection and model for a later rereview", () => {
		const options = { ...OPTIONS, agent: "grok" as const, model: "grok-4.6" };
		createStateStore(path).markBlocked(GITHUB_URL, "m1", options, "c1");
		expect(createStateStore(path).get().blocked[prKey(GITHUB_URL)]?.options).toEqual(options);
	});
	test("markBlocked keys the entry by the normalized url", () => {
		const store = createStateStore(path);
		store.markBlocked(`${GITHUB_URL}/files?x=1#frag`, "m1", OPTIONS, "c1");
		const blocked = createStateStore(path).get().blocked;
		expect(Object.keys(blocked)).toEqual([prKey(GITHUB_URL)]);
		expect(blocked[prKey(GITHUB_URL)]).toMatchObject({
			url: GITHUB_URL,
			messageId: "m1",
			verdict: "changes_requested",
			options: OPTIONS,
		});
	});

	test("clearBlocked removes the entry given a different spelling of the url", () => {
		const store = createStateStore(path);
		store.markBlocked(GITHUB_URL, "m1", OPTIONS, "c1");
		store.clearBlocked(`${GITHUB_URL}/commits`);
		expect(createStateStore(path).get().blocked).toEqual({});
	});

	test("markBlocked replaces the entry for the same PR", () => {
		const store = createStateStore(path);
		store.markBlocked(GITHUB_URL, "m1", OPTIONS, "c1");
		store.markBlocked(GITHUB_URL, "m2", { ...OPTIONS, spice: 2 }, "c1");
		const blocked = createStateStore(path).get().blocked;
		expect(Object.keys(blocked)).toHaveLength(1);
		expect(blocked[prKey(GITHUB_URL)]).toMatchObject({
			messageId: "m2",
			options: { spice: 2 },
		});
	});
});

describe("prKey", () => {
	test.each([
		[
			"https://GitHub.com/o/r/pull/12/files?x=1#frag",
			"https://github.com/o/r/pull/12",
		],
		["https://github.com/o/r/pull/12/", "https://github.com/o/r/pull/12"],
		[
			"https://github.com/o/r/pull/12/commits/abc",
			"https://github.com/o/r/pull/12",
		],
		[
			"https://gitlab.com/g/p/-/merge_requests/5/diffs?w=1",
			"https://gitlab.com/g/p/-/merge_requests/5",
		],
		["https://github.com/o/r/pull/12", "https://github.com/o/r/pull/12"],
	])("canonicalizes %s", (input, expected) => {
		expect(prKey(input)).toBe(expected);
	});

	test("keeps only the owner, repo, and number of a GitHub pull request path", () => {
		expect(prKey("https://github.com/o/r/pull/12/files/../x%20y")).toBe(
			"https://github.com/o/r/pull/12",
		);
	});

	test("is idempotent", () => {
		const once = prKey("https://GitHub.com/o/r/pull/12/files?x=1");
		expect(prKey(once)).toBe(once);
	});
});

describe("lastEventIds coalescing", () => {
	const onDisk = (chatId = "c1") =>
		JSON.parse(readFileSync(path, "utf8")).lastEventIds[chatId];

	test("writes the first id at once and holds later ids until the interval passes", async () => {
		const store = createStateStore(path, undefined, 60);
		store.setLastEventId("c1", "e1");
		store.setLastEventId("c1", "e2");
		store.setLastEventId("c1", "e3");
		expect(onDisk()).toBe("e1");
		await Bun.sleep(120);
		expect(onDisk()).toBe("e3");
	});

	test("flush writes the held id immediately", () => {
		const store = createStateStore(path, undefined, 60_000);
		store.setLastEventId("c1", "e1");
		store.setLastEventId("c1", "e2");
		store.flush();
		expect(onDisk()).toBe("e2");
	});

	test("a job-state write carries the held id", () => {
		const store = createStateStore(path, undefined, 60_000);
		store.setLastEventId("c1", "e1");
		store.setLastEventId("c1", "e2");
		store.markHandled("m1", "done");
		expect(onDisk()).toBe("e2");
	});

	test("keeps a separate id per chat in one coalesced write", () => {
		const store = createStateStore(path, undefined, 60_000);
		store.setLastEventId("c1", "a1");
		store.setLastEventId("c2", "b1");
		store.setLastEventId("c2", "b2");
		store.flush();
		expect(onDisk("c1")).toBe("a1");
		expect(onDisk("c2")).toBe("b2");
	});
});

describe("legacy lastEventId migration", () => {
	const legacy = (extra: Record<string, unknown> = {}) =>
		writeFileSync(
			path,
			JSON.stringify({ lastEventId: "old", current: null, handled: {}, blocked: {}, ...extra }),
		);

	test("moves the old id to the given chat", () => {
		legacy();
		const store = createStateStore(path, undefined, undefined, "c1");
		expect(store.get().lastEventIds).toEqual({ c1: "old" });
		store.markHandled("m1", "done");
		expect(JSON.parse(readFileSync(path, "utf8")).lastEventId).toBeUndefined();
	});

	test("drops the old id when no chat is given", () => {
		legacy();
		expect(createStateStore(path).get().lastEventIds).toEqual({});
	});

	test("prefers a stored per-chat id over the old one", () => {
		legacy({ lastEventIds: { c1: "new" } });
		expect(
			createStateStore(path, undefined, undefined, "c1").get().lastEventIds,
		).toEqual({ c1: "new" });
	});
});

describe("chat ids on records", () => {
	test("round-trips the chat id on handled, current and blocked entries", () => {
		const store = createStateStore(path);
		store.markHandled("m1", "pending", "c2");
		store.setCurrent({
			messageId: "m1",
			chatId: "c2",
			url: GITHUB_URL,
			number: 12,
			startedAt: "2026-10-14T12:00:00.000Z",
		});
		store.markBlocked(GITHUB_URL, "m1", OPTIONS, "c2");
		const reloaded = createStateStore(path).get();
		expect(reloaded.handled.m1?.chatId).toBe("c2");
		expect(reloaded.current?.chatId).toBe("c2");
		expect(Object.values(reloaded.blocked)[0]?.chatId).toBe("c2");
	});
});
