import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { channelReviewPaths } from "../src/paths";
import { AuthError, ConfigError, RateLimitError } from "../src/sinks/errors";
import { createSinks } from "../src/sinks";
import { createErrorPoller } from "../src/sinks/poller";
import { createSentrySink } from "../src/sinks/sentry";
import { createStateStore } from "../src/state";
import {
	type TempHome,
	buildIssue,
	createFixedClock,
	createRecordedLog,
	createTempHome,
	minimalConfigJson,
	writeConfigFile,
} from "./support/fakes";

const TOKEN = "sentry-token-value-123";
const ENV = { SENTRY_AUTH_TOKEN: TOKEN, SENTRY_ORG: "example-org" };
const BASE = "https://sentry.io/api/0/organizations/example-org";
const SINCE = "2026-10-14T11:00:00.000Z";

type Call = { url: string; method: string; headers: Record<string, string> };
type Reply = Response | Error;

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => {
	home.cleanup();
});

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

const linked = (body: unknown, cursor: string, more: boolean) =>
	json(body, {
		headers: {
			Link: `<https://sentry.io/prev>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/next>; rel="next"; results="${more}"; cursor="${cursor}"`,
		},
	});

function scripted(replies: Reply[]) {
	const calls: Call[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers: init?.headers as Record<string, string>,
		});
		const reply = replies.shift();
		if (reply === undefined) throw new Error("no scripted reply left");
		if (reply instanceof Error) throw reply;
		return reply;
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

function configFor(sentry: Record<string, unknown>, extra: Record<string, unknown>) {
	return loadConfig(
		writeConfigFile(
			home.dir,
			minimalConfigJson({
				errorWatch: { enabled: true, ...extra, providers: { sentry: { enabled: true, ...sentry } } },
			}),
		),
		{ env: home.env },
	);
}

function setup(
	replies: Reply[],
	sentry: Record<string, unknown> = {},
	env: Record<string, string | undefined> = ENV,
	extra: Record<string, unknown> = {},
) {
	const config = configFor(sentry, extra);
	const log = createRecordedLog();
	const { calls, fetchFn } = scripted(replies);
	const sink = createSentrySink({ config, env, fetch: fetchFn, clock: createFixedClock(), log });
	return { sink, calls, log };
}

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	shortId: `EX-${id}`,
	title: `TypeError: bad ${id}`,
	culprit: "run",
	permalink: `https://sentry.io/organizations/example-org/issues/${id}/`,
	firstSeen: "2026-10-14T11:10:00.000Z",
	lastSeen: "2026-10-14T11:40:00.000Z",
	level: "error",
	status: "unresolved",
	substatus: "new",
	count: "3",
	project: { slug: "example-api" },
	...overrides,
});

const poll = (sink: ReturnType<typeof setup>["sink"]) =>
	sink.poll({ since: new Date(SINCE), signal: new AbortController().signal });

describe("sentry poll", () => {
	test("sends the issues request with auth header and parameters", async () => {
		const run = setup([json([])], {
			projects: { include: ["12", "34"] },
			envs: { include: ["prod", "stage"], exclude: ["dev"] },
		});
		await poll(run.sink);
		const [call] = run.calls;
		const url = new URL(call?.url ?? "");
		expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/issues/`);
		expect(call?.method).toBe("GET");
		expect(call?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
		expect(url.searchParams.get("query")).toBe("is:unresolved !environment:dev");
		expect(url.searchParams.getAll("project")).toEqual(["12", "34"]);
		expect(url.searchParams.getAll("environment")).toEqual(["prod", "stage"]);
		expect(url.searchParams.get("sort")).toBe("date");
		expect(url.searchParams.get("limit")).toBe("100");
		expect(url.searchParams.get("start")).toBe(SINCE);
		expect(url.searchParams.get("end")).toBe("2026-10-14T12:00:00.000Z");
	});

	test("uses the configured base URL without a trailing slash", async () => {
		const run = setup([json([])], {}, { ...ENV, SENTRY_BASE_URL: "https://sentry.example.com/" });
		await poll(run.sink);
		expect(run.calls[0]?.url.startsWith("https://sentry.example.com/api/0/organizations/example-org/issues/?")).toBe(
			true,
		);
	});

	test("maps issues and returns the newest first seen as the cursor", async () => {
		const run = setup([
			json([
				row("1"),
				row("2", { substatus: "regressed", firstSeen: "2026-10-01T00:00:00.000Z", level: "fatal" }),
			]),
		]);
		const result = await poll(run.sink);
		expect(result.cursor).toBe("2026-10-14T11:10:00.000Z");
		expect(result.issues).toEqual([
			{
				id: "1",
				title: "TypeError: bad 1",
				service: "example-api",
				env: "unknown",
				level: "error",
				firstSeen: "2026-10-14T11:10:00.000Z",
				lastSeen: "2026-10-14T11:40:00.000Z",
				link: "https://sentry.io/organizations/example-org/issues/1/",
				regressed: false,
			},
			expect.objectContaining({ id: "2", level: "fatal", regressed: true }),
		]);
	});

	test("takes the env from a single included env", async () => {
		const run = setup([json([row("1")])], { envs: { include: ["prod"] } });
		const { issues } = await poll(run.sink);
		expect(issues[0]?.env).toBe("prod");
	});

	test("keeps new by substatus or first seen and drops ongoing issues", async () => {
		const run = setup([
			json([
				row("sub", { substatus: "new", firstSeen: "2026-10-01T00:00:00.000Z" }),
				row("fresh", { substatus: "ongoing" }),
				row("old", { substatus: "ongoing", firstSeen: "2026-10-01T00:00:00.000Z" }),
				row("back", { substatus: "regressed", firstSeen: "2026-10-01T00:00:00.000Z" }),
			]),
		]);
		const { issues } = await poll(run.sink);
		expect(issues.map((issue) => issue.id)).toEqual(["sub", "fresh", "back"]);
		expect(issues.map((issue) => issue.regressed)).toEqual([false, false, true]);
	});

	test("drops issues below the minimum level and unknown levels", async () => {
		const run = setup(
			[json([row("1", { level: "warning" }), row("2", { level: "info" }), row("3", { level: "fatal" })])],
			{},
			ENV,
			{ minLevel: "error" },
		);
		const { issues } = await poll(run.sink);
		expect(issues.map((issue) => issue.id)).toEqual(["3"]);
	});

	test("drops excluded projects and malformed rows", async () => {
		const run = setup([json([row("1", { project: { slug: "noisy" } }), { id: "2" }, row("3")])], {
			projects: { exclude: ["noisy"] },
		});
		const { issues } = await poll(run.sink);
		expect(issues.map((issue) => issue.id)).toEqual(["3"]);
	});

	test("returns no cursor when nothing matched", async () => {
		const run = setup([json([])]);
		expect(await poll(run.sink)).toEqual({ issues: [], cursor: undefined });
	});
});

describe("sentry pagination", () => {
	test("follows the next cursor and stops when results is false", async () => {
		const run = setup([
			linked([row("1")], "0:100:0", true),
			linked([row("2")], "0:200:0", false),
		]);
		const { issues } = await poll(run.sink);
		expect(issues.map((issue) => issue.id)).toEqual(["1", "2"]);
		expect(run.calls).toHaveLength(2);
		expect(new URL(run.calls[0]?.url ?? "").searchParams.get("cursor")).toBeNull();
		expect(new URL(run.calls[1]?.url ?? "").searchParams.get("cursor")).toBe("0:100:0");
	});

	test("stops after five pages and warns", async () => {
		const run = setup(
			Array.from({ length: 6 }, (_, i) => linked([row(String(i))], `0:${i}:0`, true)),
		);
		const { issues } = await poll(run.sink);
		expect(run.calls).toHaveLength(5);
		expect(issues).toHaveLength(5);
		expect(run.log.lines.some((line) => line.level === "warn" && line.message.includes("pages"))).toBe(true);
	});

	test("does not warn when the fifth page is the last", async () => {
		const run = setup([
			...Array.from({ length: 4 }, (_, i) => linked([row(String(i))], `0:${i}:0`, true)),
			linked([row("4")], "0:4:0", false),
		]);
		await poll(run.sink);
		expect(run.log.lines.some((line) => line.level === "warn")).toBe(false);
	});
});

describe("sentry errors", () => {
	test.each([
		["30", 30_000],
		["0", 1_000],
		["9999", 300_000],
	])("429 with Retry-After %s waits %d ms", async (header, ms) => {
		const run = setup([new Response("", { status: 429, headers: { "Retry-After": header } })]);
		const error = await poll(run.sink).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RateLimitError);
		expect((error as RateLimitError).retryAfterMs).toBe(ms);
	});

	test("429 with X-Sentry-Rate-Limit-Reset waits until the epoch second", async () => {
		const reset = Date.parse("2026-10-14T12:00:45.000Z") / 1000;
		const run = setup([new Response("", { status: 429, headers: { "X-Sentry-Rate-Limit-Reset": String(reset) } })]);
		const error = (await poll(run.sink).catch((e: unknown) => e)) as RateLimitError;
		expect(error).toBeInstanceOf(RateLimitError);
		expect(error.retryAfterMs).toBe(45_000);
	});

	test("Retry-After wins over the reset header", async () => {
		const run = setup([
			new Response("", {
				status: 429,
				headers: { "Retry-After": "20", "X-Sentry-Rate-Limit-Reset": "9999999999" },
			}),
		]);
		const error = (await poll(run.sink).catch((e: unknown) => e)) as RateLimitError;
		expect(error.retryAfterMs).toBe(20_000);
	});

	test("429 without headers defaults to 60 seconds", async () => {
		const run = setup([new Response("", { status: 429 })]);
		const error = (await poll(run.sink).catch((e: unknown) => e)) as RateLimitError;
		expect(error.retryAfterMs).toBe(60_000);
	});

	test.each([401, 403])("%d throws an AuthError", async (status) => {
		const run = setup([new Response("", { status })]);
		await expect(poll(run.sink)).rejects.toBeInstanceOf(AuthError);
	});

	test("a 5xx throws a generic error that names no token", async () => {
		const run = setup([new Response("", { status: 502 })]);
		const error = (await poll(run.sink).catch((e: unknown) => e)) as Error;
		expect(error).not.toBeInstanceOf(AuthError);
		expect(error.message).toContain("502");
		expect(error.message).not.toContain(TOKEN);
	});

	test("a body that is not JSON throws", async () => {
		const run = setup([new Response("<html>", { status: 200 })]);
		await expect(poll(run.sink)).rejects.toThrow("invalid JSON");
	});

	test("missing variables name them and never the values", async () => {
		const run = setup([], {}, { SENTRY_AUTH_TOKEN: TOKEN });
		const error = (await poll(run.sink).catch((e: unknown) => e)) as ConfigError;
		expect(error).toBeInstanceOf(ConfigError);
		expect(error.missing).toEqual(["SENTRY_ORG"]);
		expect(error.message).not.toContain(TOKEN);
		expect(run.calls).toEqual([]);
	});

	test("lists both variables when both are missing", async () => {
		const run = setup([], {}, {});
		const error = (await poll(run.sink).catch((e: unknown) => e)) as ConfigError;
		expect(error.missing).toEqual(["SENTRY_AUTH_TOKEN", "SENTRY_ORG"]);
	});
});

describe("sentry detail", () => {
	const issue = buildIssue("42", { env: "unknown" });
	const frame = (n: number) => ({ filename: `src/f${n}.ts`, lineno: n, function: `fn${n}` });
	const event = {
		message: "boom",
		entries: [
			{ type: "message", data: {} },
			{
				type: "exception",
				data: { values: [{ stacktrace: { frames: Array.from({ length: 35 }, (_, i) => frame(i + 1)) } }] },
			},
		],
		tags: [
			{ key: "environment", value: "prod" },
			{ key: "release", value: "1.2.3" },
			{ key: "git.repository_url", value: "https://github.com/acme/widgets.git" },
		],
	};

	test("reads the latest event, keeps the last 30 frames and the repo tag", async () => {
		const run = setup([json(event)]);
		const report = await run.sink.detail(issue);
		expect(run.calls[0]?.url).toBe(`${BASE}/issues/42/events/latest/`);
		const lines = report.stack?.split("\n") ?? [];
		expect(lines).toHaveLength(30);
		expect(lines[0]).toBe("src/f6.ts:6 in fn6");
		expect(lines.at(-1)).toBe("src/f35.ts:35 in fn35");
		expect(report).toMatchObject({
			message: "boom",
			env: "prod",
			repoTag: "github.com/acme/widgets",
			link: issue.link,
		});
	});

	test("formats frames with missing parts and reads the repo from contexts", async () => {
		const run = setup([
			json({
				entries: [
					{
						type: "exception",
						data: { values: [{ stacktrace: { frames: [{ module: "app.mod" }, { filename: "a.ts", lineno: 3 }] } }] },
					},
				],
				contexts: { repository: { url: "git@github.com:acme/widgets.git" } },
			}),
		]);
		const report = await run.sink.detail(buildIssue("42"));
		expect(report.stack).toBe("app.mod\na.ts:3");
		expect(report.message).toBe(issue.title);
		expect(report.repoTag).toBe("github.com/acme/widgets");
	});

	test("leaves stack and repo undefined when the event has none", async () => {
		const run = setup([json({ entries: [] })]);
		const report = await run.sink.detail(issue);
		expect(report).toMatchObject({ stack: undefined, repoTag: undefined, env: "unknown" });
	});

	test("keeps the polled env over the environment tag", async () => {
		const run = setup([json(event)]);
		const report = await run.sink.detail(buildIssue("42", { env: "stage" }));
		expect(report.env).toBe("stage");
	});

	test("returns a report without a stack and warns when the lookup fails", async () => {
		const run = setup([new Response("", { status: 500 })]);
		const report = await run.sink.detail(issue);
		expect(report).toMatchObject({ message: issue.title, stack: undefined, repoTag: undefined });
		expect(run.log.lines.some((line) => line.level === "warn")).toBe(true);
	});

	test("tolerates an auth failure and a network failure", async () => {
		const run = setup([new Response("", { status: 403 }), new Error("socket hang up")]);
		expect((await run.sink.detail(issue)).stack).toBeUndefined();
		expect((await run.sink.detail(issue)).stack).toBeUndefined();
	});
});

describe("sentry with the error poller", () => {
	test("seeds on the first tick and hands off a new issue on the next", async () => {
		const config = configFor({}, {});
		const clock = createFixedClock();
		const { calls, fetchFn } = scripted([
			json([row("1")]),
			json([row("1"), row("2", { firstSeen: "2026-10-14T12:30:00.000Z" })]),
		]);
		const sink = createSentrySink({ config, env: ENV, fetch: fetchFn, clock, log: createRecordedLog() });
		const handed: [string, string][] = [];
		const state = home.track(createStateStore(channelReviewPaths("dev", { env: home.env }), clock));
		const poller = createErrorPoller({
			config,
			sinks: [sink],
			state,
			onIssue: async (issue, name) => {
				handed.push([name, issue.id]);
			},
			log: createRecordedLog(),
			clock,
			sleep: async () => {},
		});
		const signal = new AbortController().signal;
		await poller.tick(signal);
		expect(handed).toEqual([]);
		expect(state.get().sinks.sentry?.cursor).toBe("2026-10-14T11:10:00.000Z");
		await poller.tick(signal);
		expect(handed).toEqual([["sentry", "2"]]);
		expect(new URL(calls[1]?.url ?? "").searchParams.get("start")).toBe("2026-10-14T11:10:00.000Z");
	});
});

describe("createSinks with sentry", () => {
	test("returns the sentry sink when the provider is on", () => {
		const config = configFor({}, {});
		const sinks = createSinks(config, ENV, {
			fetch: scripted([]).fetchFn,
			clock: createFixedClock(),
			log: createRecordedLog(),
		});
		expect(sinks.map((sink) => sink.name)).toEqual(["sentry"]);
	});
});
