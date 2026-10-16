import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { buildQuery, createDatadogSink, normalizeRepoUrl } from "../src/sinks/datadog";
import { AuthError, ConfigError, RateLimitError } from "../src/sinks/errors";
import { createSinks } from "../src/sinks";
import {
	type TempHome,
	buildIssue,
	createFixedClock,
	createRecordedLog,
	createTempHome,
	minimalConfigJson,
	writeConfigFile,
} from "./support/fakes";

const API_KEY = "api-key-value-123";
const APP_KEY = "app-key-value-456";
const ENV = { DATADOG_API_KEY: API_KEY, DATADOG_APP_KEY: APP_KEY };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = Response | Error | (() => Response);

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => {
	home.cleanup();
});

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

function scripted(replies: Reply[]) {
	const calls: Call[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers: init?.headers as Record<string, string>,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const reply = replies.shift();
		if (reply === undefined) throw new Error("no scripted reply left");
		if (reply instanceof Error) throw reply;
		return typeof reply === "function" ? reply() : reply;
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

function setup(
	replies: Reply[],
	datadog: Record<string, unknown> = {},
	env: Record<string, string | undefined> = ENV,
	extra: Record<string, unknown> = {},
) {
	const config = loadConfig(
		writeConfigFile(
			home.dir,
			minimalConfigJson({
				errorWatch: { enabled: true, ...extra, providers: { datadog: { enabled: true, ...datadog } } },
			}),
		),
		{ env: home.env },
	);
	const log = createRecordedLog();
	const { calls, fetchFn } = scripted(replies);
	const clock = createFixedClock();
	const sink = createDatadogSink({ config, env, fetch: fetchFn, clock, log });
	return { sink, calls, log, config, clock };
}

const row = (id: string, attributes: Record<string, unknown> = {}) => ({
	id,
	type: "issue",
	attributes: {
		error_type: "TypeError",
		error_message: `bad ${id}`,
		service: "example-api",
		first_seen: Date.parse("2026-10-14T11:00:00.000Z"),
		last_seen: Date.parse("2026-10-14T11:30:00.000Z"),
		state: "OPEN",
		...attributes,
	},
});

const result = (id: string) => ({
	id: `result-${id}`,
	type: "error_tracking_search_result",
	attributes: { impacted_sessions: 1, impacted_users: 1, total_count: 5 },
	relationships: { issue: { data: { id, type: "issue" } } },
});

const search = (...issues: ReturnType<typeof row>[]) => ({
	data: issues.map((issue) => result(issue.id)),
	included: issues,
});

const poll = (sink: ReturnType<typeof setup>["sink"]) =>
	sink.poll({ since: new Date("2026-10-14T11:00:00.000Z"), signal: new AbortController().signal });

describe("buildQuery", () => {
	test("joins include lists with OR and exclusions with a minus", () => {
		expect(
			buildQuery(
				{ include: ["a", "b"], exclude: ["noisy"] },
				{ include: ["prod"], exclude: ["dev", "test"] },
			),
		).toBe("service:(a OR b) env:(prod) -service:(noisy) -env:(dev OR test)");
	});

	test("is empty without filters", () => {
		expect(buildQuery({ include: [], exclude: [] }, { include: [], exclude: [] })).toBe("");
	});
});

describe("normalizeRepoUrl", () => {
	test.each([
		["https://github.com/Acme/widgets.git", "github.com/Acme/widgets"],
		["https://user:token@github.com/acme/widgets", "github.com/acme/widgets"],
		["git@github.com:acme/widgets.git", "github.com/acme/widgets"],
		["ssh://git@GitHub.com/acme/widgets.git", "github.com/acme/widgets"],
		["github.com/acme/widgets/", "github.com/acme/widgets"],
	])("%s", (input, expected) => {
		expect(normalizeRepoUrl(input)).toBe(expected);
	});

	test("rejects text that is not a repository URL", () => {
		expect(normalizeRepoUrl("nonsense")).toBeUndefined();
	});
});

describe("datadog poll", () => {
	test("sends the search request with keys, query, window and track", async () => {
		const run = setup([json({ data: [] })], {
			tracks: ["trace"],
			services: { include: ["a", "b"] },
			envs: { include: ["prod"] },
		});
		await poll(run.sink);
		const [call] = run.calls;
		expect(call?.url).toBe("https://api.datadoghq.com/api/v2/error-tracking/issues/search?include=issue");
		expect(call?.method).toBe("POST");
		expect(call?.headers).toMatchObject({ "DD-API-KEY": API_KEY, "DD-APPLICATION-KEY": APP_KEY });
		expect(call?.body).toEqual({
			data: {
				type: "search_request",
				attributes: {
					query: "service:(a OR b) env:(prod)",
					from: Date.parse("2026-10-14T11:00:00.000Z"),
					to: Date.parse("2026-10-14T12:00:00.000Z"),
					track: "trace",
					order_by: "FIRST_SEEN",
				},
			},
		});
	});

	test("uses the configured site and polls every track", async () => {
		const run = setup(
			[json({ data: [] }), json({ data: [] })],
			{ tracks: ["trace", "logs"] },
			{ ...ENV, DATADOG_SITE: "datadoghq.eu" },
		);
		await poll(run.sink);
		expect(run.calls.map((call) => call.url)).toEqual([
			"https://api.datadoghq.eu/api/v2/error-tracking/issues/search?include=issue",
			"https://api.datadoghq.eu/api/v2/error-tracking/issues/search?include=issue",
		]);
		expect(run.calls.map((call) => (call.body as { data: { attributes: { track: string } } }).data.attributes.track)).toEqual([
			"trace",
			"logs",
		]);
	});

	test("joins issues from included and returns the newest first seen as the cursor", async () => {
		const run = setup([
			json({
				...search(
					row("1", { is_crash: true, regression: { regressed_at: "2026-10-14T11:50:00.000Z" } }),
					row("2", { first_seen: Date.parse("2026-10-14T11:45:00.000Z") }),
				),
				included: [
					...search(
						row("1", { is_crash: true, regression: { regressed_at: "2026-10-14T11:50:00.000Z" } }),
						row("2", { first_seen: Date.parse("2026-10-14T11:45:00.000Z") }),
					).included,
					{ id: "u", type: "user", attributes: { service: "x" } },
				],
			}),
		]);
		const result = await poll(run.sink);
		expect(result.cursor).toBe("2026-10-14T11:45:00.000Z");
		expect(result.issues).toEqual([
			{
				id: "1",
				title: "TypeError: bad 1",
				service: "example-api",
				env: "unknown",
				level: "fatal",
				firstSeen: "2026-10-14T11:00:00.000Z",
				lastSeen: "2026-10-14T11:50:00.000Z",
				link: "https://app.datadoghq.com/error-tracking?issueId=1",
				regressed: true,
			},
			expect.objectContaining({ id: "2", level: "error", regressed: false }),
		]);
	});

	test("uses the single included env and falls back to the message or id for the title", async () => {
		const run = setup(
			[
				json(
					search(
						row("9", { error_type: undefined }),
						row("8", { error_type: undefined, error_message: undefined }),
					),
				),
			],
			{ envs: { include: ["prod"] } },
		);
		const { issues } = await poll(run.sink);
		expect(issues.map((issue) => [issue.title, issue.env])).toEqual([
			["bad 9", "prod"],
			["8", "prod"],
		]);
	});

	test("skips ignored and excluded issues and malformed rows", async () => {
		const run = setup([
			json({
				included: [
					row("1", { state: "IGNORED" }),
					row("2", { state: "EXCLUDED" }),
					{ id: "3", type: "issue" },
					row("ok", { state: "RESOLVED" }),
				],
			}),
		]);
		const { issues } = await poll(run.sink);
		expect(issues.map((issue) => issue.id)).toEqual(["ok"]);
	});

	test("drops excluded services client-side and keeps the env exclusion in the query", async () => {
		const run = setup([json(search(row("1", { service: "noisy" }), row("3")))], {
			services: { exclude: ["noisy"] },
			envs: { exclude: ["dev"] },
		});
		const { issues } = await poll(run.sink);
		expect(issues.map((issue) => issue.id)).toEqual(["3"]);
		const query = (run.calls[0]?.body as { data: { attributes: { query: string } } }).data.attributes.query;
		expect(query).toBe("-service:(noisy) -env:(dev)");
	});

	test("drops issues below the minimum level", async () => {
		const run = setup([json(search(row("1"), row("2", { is_crash: true })))], {}, ENV, {
			minLevel: "fatal",
		});
		const { issues } = await poll(run.sink);
		expect(issues.map((issue) => issue.id)).toEqual(["2"]);
	});

	test("warns when a page is full", async () => {
		const run = setup([json(search(...Array.from({ length: 100 }, (_, i) => row(String(i)))))]);
		await poll(run.sink);
		expect(run.log.lines.some((line) => line.level === "warn" && line.message.includes("full page"))).toBe(true);
	});

	test("returns no cursor when nothing matched", async () => {
		const run = setup([json({})]);
		expect(await poll(run.sink)).toEqual({ issues: [], cursor: undefined });
	});
});

describe("datadog errors", () => {
	test.each([
		["30", 30_000],
		["0", 1_000],
		["9999", 300_000],
		["soon", 60_000],
	])("429 with Retry-After %s waits %d ms", async (header, ms) => {
		const run = setup([new Response("", { status: 429, headers: { "Retry-After": header } })]);
		const error = await poll(run.sink).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RateLimitError);
		expect((error as RateLimitError).retryAfterMs).toBe(ms);
	});

	test("429 without Retry-After defaults to 60 seconds", async () => {
		const run = setup([new Response("", { status: 429 })]);
		const error = await poll(run.sink).catch((e: unknown) => e);
		expect((error as RateLimitError).retryAfterMs).toBe(60_000);
	});

	test.each([401, 403])("%d throws an AuthError", async (status) => {
		const run = setup([new Response("", { status })]);
		await expect(poll(run.sink)).rejects.toBeInstanceOf(AuthError);
	});

	test("a 5xx throws a generic error that names no keys", async () => {
		const run = setup([new Response("", { status: 503 })]);
		const error = await poll(run.sink).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(AuthError);
		expect((error as Error).message).toContain("503");
		expect((error as Error).message).not.toContain(API_KEY);
	});

	test("a network failure propagates", async () => {
		const run = setup([new Error("socket hang up")]);
		await expect(poll(run.sink)).rejects.toThrow("socket hang up");
	});

	test("a body that is not JSON throws", async () => {
		const run = setup([new Response("<html>", { status: 200 })]);
		await expect(poll(run.sink)).rejects.toThrow("invalid JSON");
	});

	test("missing keys name the variables and never the values", async () => {
		const run = setup([], {}, { DATADOG_APP_KEY: APP_KEY });
		const error = await poll(run.sink).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain("DATADOG_API_KEY");
		expect((error as ConfigError).message).not.toContain("DATADOG_APP_KEY");
		expect((error as ConfigError).message).not.toContain(APP_KEY);
		expect(run.calls).toEqual([]);
	});

	test("lists both variables when both are missing", async () => {
		const run = setup([], {}, {});
		const error = (await poll(run.sink).catch((e: unknown) => e)) as ConfigError;
		expect(error.missing).toEqual(["DATADOG_API_KEY", "DATADOG_APP_KEY"]);
	});
});

describe("datadog detail", () => {
	const issue = buildIssue("42");
	const spanEvent = {
		data: [
			{
				attributes: {
					attributes: {
						error: { stack: "Error: boom\n  at run", message: "boom" },
						custom: { git: { repository_url: "https://github.com/acme/widgets.git" } },
					},
					tags: ["env:prod"],
				},
			},
		],
	};

	test("reads the issue, then the span event for stack and repo", async () => {
		const run = setup([json({ data: { attributes: { error_message: "from issue" } } }), json(spanEvent)]);
		const report = await run.sink.detail(issue);
		expect(run.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			"GET https://api.datadoghq.com/api/v2/error-tracking/issues/42",
			"POST https://api.datadoghq.com/api/v2/spans/events/search",
		]);
		expect(run.calls[1]?.body).toEqual({
			filter: { query: "issue.id:42", from: "now-30d", to: "now" },
			page: { limit: 1 },
		});
		expect(report).toMatchObject({
			id: "42",
			message: "boom",
			stack: "Error: boom\n  at run",
			repoTag: "github.com/acme/widgets",
			link: issue.link,
		});
	});

	test("reads the repo from a git.repository_url tag", async () => {
		const run = setup([
			json({ data: { attributes: {} } }),
			json({
				data: [{ attributes: { tags: ["git.repository_url:git@github.com:acme/widgets.git"] } }],
			}),
		]);
		const report = await run.sink.detail(issue);
		expect(report.repoTag).toBe("github.com/acme/widgets");
		expect(report.stack).toBeUndefined();
	});

	test("uses the logs endpoint for a logs track issue", async () => {
		const run = setup(
			[
				json(search(row("42"))),
				json({ data: { attributes: {} } }),
				json({ data: [] }),
			],
			{ tracks: ["logs"] },
		);
		const [polled] = (await poll(run.sink)).issues;
		await run.sink.detail(polled ?? issue);
		expect(run.calls[2]?.url).toBe("https://api.datadoghq.com/api/v2/logs/events/search");
	});

	test("returns the report without stack or repo when the events lookup fails", async () => {
		const run = setup([
			json({ data: { attributes: { error_message: "from issue" } } }),
			new Response("", { status: 500 }),
		]);
		const report = await run.sink.detail(issue);
		expect(report).toMatchObject({ message: "from issue", stack: undefined, repoTag: undefined });
		expect(run.log.lines.some((line) => line.level === "warn")).toBe(true);
	});

	test("propagates a failure of the issue lookup", async () => {
		const run = setup([new Response("", { status: 404 })]);
		await expect(run.sink.detail(issue)).rejects.toThrow("404");
	});
});

describe("createSinks", () => {
	function build(errorWatch: Record<string, unknown>) {
		const config = loadConfig(writeConfigFile(home.dir, minimalConfigJson({ errorWatch })), {
			env: home.env,
		});
		return createSinks(config, ENV, {
			fetch: scripted([]).fetchFn,
			clock: createFixedClock(),
			log: createRecordedLog(),
		});
	}

	test("returns nothing while the master switch is off", () => {
		expect(build({ providers: { datadog: { enabled: true } } })).toEqual([]);
	});

	test("returns nothing while the provider is off", () => {
		expect(build({ enabled: true })).toEqual([]);
	});

	test("returns the datadog sink when both are on", () => {
		expect(build({ enabled: true, providers: { datadog: { enabled: true } } }).map((s) => s.name)).toEqual([
			"datadog",
		]);
	});
});
