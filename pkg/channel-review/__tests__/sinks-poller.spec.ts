import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { RateLimitError } from "../src/sinks/errors";
import { createErrorPoller, issueKey } from "../src/sinks/poller";
import type { SinkIssue } from "../src/sinks/types";
import { createStateStore } from "../src/state";
import {
	type TempHome,
	buildIssue,
	createFakeSink,
	createFixedClock,
	createRecordedLog,
	createTempHome,
	minimalConfigJson,
	writeConfigFile,
} from "./support/fakes";

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => {
	home.cleanup();
});

const signal = new AbortController().signal;
const key = (id: string) => issueKey("fake", id);

function setup(errorWatch: Record<string, unknown> = { enabled: true }) {
	const config = loadConfig(writeConfigFile(home.dir, minimalConfigJson({ errorWatch })), {
		env: home.env,
	});
	const clock = createFixedClock();
	const statePath = join(home.dir, "state.json");
	const sink = createFakeSink();
	const handed: [string, string][] = [];
	const sleeps: number[] = [];
	const log = createRecordedLog();
	function build() {
		const state = createStateStore(statePath, clock);
		const poller = createErrorPoller({
			config,
			sinks: [sink],
			state,
			onIssue: async (issue: SinkIssue, name: string) => {
				handed.push([name, issue.id]);
			},
			log,
			clock,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		return { state, poller };
	}
	return { ...build(), build, sink, handed, sleeps, clock, log };
}

describe("error poller", () => {
	test("marks every issue seen on the first run without calling onIssue", async () => {
		const run = setup();
		run.sink.issues = [buildIssue("1"), buildIssue("2")];
		run.sink.cursor = "2026-10-14T11:40:00.000Z";
		await run.poller.tick(signal);
		expect(run.handed).toEqual([]);
		expect(run.state.get().issues[key("1")]?.status).toBe("seen");
		expect(run.state.get().issues[key("2")]?.status).toBe("seen");
		expect(run.state.get().sinks.fake).toMatchObject({
			cursor: "2026-10-14T11:40:00.000Z",
			lastPollAt: "2026-10-14T12:00:00.000Z",
			lastError: undefined,
		});
	});

	test("sets a cursor on the first run even when nothing came back", async () => {
		const run = setup();
		await run.poller.tick(signal);
		expect(run.state.get().sinks.fake?.cursor).toBe("2026-10-14T12:00:00.000Z");
		run.sink.issues = [buildIssue("1")];
		await run.poller.tick(signal);
		expect(run.handed).toEqual([["fake", "1"]]);
	});

	test("hands off a new issue once and not again", async () => {
		const run = setup();
		await run.poller.tick(signal);
		run.sink.issues = [buildIssue("1")];
		await run.poller.tick(signal);
		await run.poller.tick(signal);
		expect(run.handed).toEqual([["fake", "1"]]);
		expect(run.state.get().sinks.fake?.counts).toMatchObject({ triggered: 1, polled: 2 });
	});

	test("asks for the later of the cursor and the lookback window", async () => {
		const run = setup({ enabled: true, lookbackMinutes: 30 });
		run.sink.cursor = "2026-10-14T11:50:00.000Z";
		await run.poller.tick(signal);
		expect(run.sink.polls[0]?.since.toISOString()).toBe("2026-10-14T11:30:00.000Z");
		await run.poller.tick(signal);
		expect(run.sink.polls[1]?.since.toISOString()).toBe("2026-10-14T11:50:00.000Z");
		run.clock.advance(3_600_000);
		await run.poller.tick(signal);
		expect(run.sink.polls[2]?.since.toISOString()).toBe("2026-10-14T12:30:00.000Z");
	});

	test("hands off a regressed issue that was seen before and has new events", async () => {
		const run = setup();
		run.sink.issues = [buildIssue("1")];
		await run.poller.tick(signal);
		run.clock.advance(60_000);
		run.sink.issues = [buildIssue("1", { regressed: true, lastSeen: "2026-10-14T12:00:30.000Z" })];
		await run.poller.tick(signal);
		expect(run.handed).toEqual([["fake", "1"]]);
		await run.poller.tick(signal);
		expect(run.handed).toHaveLength(1);
	});

	test("ignores a regressed flag with no activity since the last hand-off", async () => {
		const run = setup();
		run.sink.issues = [buildIssue("1", { regressed: true })];
		await run.poller.tick(signal);
		run.clock.advance(60_000);
		await run.poller.tick(signal);
		expect(run.handed).toEqual([]);
	});

	test("does not hand off an issue again after a restart", async () => {
		const run = setup();
		await run.poller.tick(signal);
		run.sink.issues = [buildIssue("1")];
		await run.poller.tick(signal);
		const restarted = run.build();
		await restarted.poller.tick(signal);
		expect(run.handed).toEqual([["fake", "1"]]);
	});

	test("retries a deferred issue and polls back to its first sighting", async () => {
		const run = setup();
		await run.poller.tick(signal);
		run.clock.advance(3_600_000);
		run.state.setIssue(key("1"), { status: "deferred", firstSeen: "2026-10-14T11:30:00.000Z" });
		run.sink.issues = [buildIssue("1")];
		await run.poller.tick(signal);
		expect(run.sink.polls.at(-1)?.since.toISOString()).toBe("2026-10-14T11:30:00.000Z");
		expect(run.handed).toEqual([["fake", "1"]]);
	});

	test("marks an issue failed and keeps going when the hand-off throws", async () => {
		const run = setup();
		await run.poller.tick(signal);
		run.sink.issues = [buildIssue("1"), buildIssue("2")];
		const failing = createErrorPoller({
			config: loadConfig(writeConfigFile(home.dir, minimalConfigJson({ errorWatch: { enabled: true } })), {
				env: home.env,
			}),
			sinks: [run.sink],
			state: run.state,
			onIssue: async (issue) => {
				if (issue.id === "1") throw new Error("boom");
				run.handed.push(["fake", issue.id]);
			},
			log: run.log,
			clock: run.clock,
		});
		await failing.tick(signal);
		expect(run.state.get().issues[key("1")]?.status).toBe("failed");
		expect(run.handed).toEqual([["fake", "2"]]);
	});

	test("records the message and rethrows when the poll fails", async () => {
		const run = setup();
		await run.poller.tick(signal);
		run.sink.failPoll = new Error("datadog down");
		await expect(run.poller.tick(signal)).rejects.toThrow("datadog down");
		expect(run.state.get().sinks.fake?.lastError).toBe("datadog down");
		expect(run.state.get().sinks.fake?.cursor).toBeDefined();
		run.sink.failPoll = undefined;
		await run.poller.tick(signal);
		expect(run.state.get().sinks.fake?.lastError).toBeUndefined();
	});

	test("waits out a rate limit before rethrowing", async () => {
		const run = setup();
		run.sink.failPoll = new RateLimitError(45_000);
		await expect(run.poller.tick(signal)).rejects.toBeInstanceOf(RateLimitError);
		expect(run.sleeps).toEqual([45_000]);
	});

	test("makes no calls while the master switch is off", async () => {
		const run = setup({ enabled: false });
		await run.poller.tick(signal);
		expect(run.sink.polls).toEqual([]);
		expect(run.state.get().sinks).toEqual({});
	});
});
