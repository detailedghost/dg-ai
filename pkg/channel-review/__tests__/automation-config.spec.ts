import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { loadConfig } from "../src/config";
import { type TempHome, createTempHome, minimalConfigJson, writeConfigFile } from "./support/fakes";

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => {
	home.cleanup();
});

const load = (extra: Record<string, unknown> = {}) =>
	loadConfig(writeConfigFile(home.dir, minimalConfigJson(extra)), { env: home.env });

const failure = (extra: Record<string, unknown>): string => {
	try {
		load(extra);
	} catch (error) {
		expect(error).toBeInstanceOf(DgCliError);
		return (error as Error).message;
	}
	throw new Error("expected loadConfig to throw");
};

describe("loadConfig automation", () => {
	test("defaults the clone root under DG_HOME and the notify target to the owner", () => {
		expect(load().automation).toEqual({
			cloneRoot: join(home.dir, "channel-review", "clones"),
			notify: { target: "owner" },
		});
	});

	test("accepts a clone root and a chat id as the notify target", () => {
		const { automation } = load({
			automation: { cloneRoot: "/srv/bot", notify: { target: "19:chat@thread.v2" } },
		});
		expect(automation).toEqual({ cloneRoot: "/srv/bot", notify: { target: "19:chat@thread.v2" } });
	});

	test.each([
		["a relative clone root", { cloneRoot: "bot" }, "automation.cloneRoot"],
		["a clone root under the code directory", { cloneRoot: join(homedir(), "code", "x") }, "automation.cloneRoot"],
		["the code directory itself", { cloneRoot: join(homedir(), "code") }, "automation.cloneRoot"],
		["an empty target", { notify: { target: "" } }, "automation.notify.target"],
		["an unknown key", { extra: 1 }, "automation.extra"],
		["an unknown notify key", { notify: { quiet: true } }, "automation.notify.quiet"],
	])("rejects %s", (_name, automation, key) => {
		expect(failure({ automation })).toContain(key);
	});

	test("accepts a sibling of the code directory", () => {
		expect(load({ automation: { cloneRoot: join(homedir(), "codebase", "x") } }).automation.cloneRoot).toBe(
			join(homedir(), "codebase", "x"),
		);
	});
});

describe("loadConfig errorWatch", () => {
	test("defaults to off with safe values", () => {
		const watch = load().errorWatch;
		expect(watch).toMatchObject({
			enabled: false,
			pollMinutes: 5,
			lookbackMinutes: 60,
			minLevel: "error",
			repos: {},
			autoFix: { enabled: true, maxPerHour: 2, timeoutMinutes: 45 },
		});
		expect(watch.providers.datadog).toEqual({
			enabled: false,
			tracks: ["trace"],
			services: { include: [], exclude: [] },
			envs: { include: [], exclude: [] },
		});
		expect(watch.providers.sentry).toEqual({
			enabled: false,
			projects: { include: [], exclude: [] },
			envs: { include: [], exclude: [] },
		});
	});

	test("builds the fix allowlist from the clone root", () => {
		const tools = load({ automation: { cloneRoot: "/srv/bot" } }).errorWatch.autoFix.allowedTools;
		expect(tools).toEqual([
			"Agent",
			"Edit(//srv/bot/**)",
			"Read(//srv/bot/**)",
			"Grep(//srv/bot/**)",
			"Glob(//srv/bot/**)",
			"Bash(git status:*)",
			"Bash(git diff:*)",
			"Bash(git log:*)",
			"Bash(bun:*)",
			"Bash(npm:*)",
			"Bash(npx:*)",
			"Bash(dotnet:*)",
			"Bash(pytest:*)",
		]);
		expect(tools).not.toContain("Bash(git:*)");
	});

	test("keeps a configured allowlist", () => {
		expect(load({ errorWatch: { autoFix: { allowedTools: ["Read"] } } }).errorWatch.autoFix.allowedTools).toEqual([
			"Read",
		]);
	});

	test("reads every configured key", () => {
		const watch = load({
			errorWatch: {
				enabled: true,
				pollMinutes: 2,
				lookbackMinutes: 30,
				minLevel: "fatal",
				providers: {
					datadog: { enabled: true, tracks: ["trace", "logs"], services: { include: [" api "] }, envs: { exclude: ["dev"] } },
					sentry: { enabled: true, projects: { include: ["web"] } },
				},
				repos: { "example-api": { repo: "github.com/example-org/api", branch: "main", autoFix: false } },
				autoFix: { enabled: false, maxPerHour: 5, timeoutMinutes: 10 },
			},
		}).errorWatch;
		expect(watch).toMatchObject({ enabled: true, pollMinutes: 2, lookbackMinutes: 30, minLevel: "fatal" });
		expect(watch.providers.datadog.tracks).toEqual(["trace", "logs"]);
		expect(watch.providers.datadog.services.include).toEqual(["api"]);
		expect(watch.providers.sentry.projects.include).toEqual(["web"]);
		expect(watch.repos["example-api"]).toEqual({ repo: "github.com/example-org/api", branch: "main", autoFix: false });
		expect(watch.autoFix).toMatchObject({ enabled: false, maxPerHour: 5, timeoutMinutes: 10 });
	});

	test.each([
		["a zero poll interval", { pollMinutes: 0 }, "errorWatch.pollMinutes"],
		["a negative lookback", { lookbackMinutes: -1 }, "errorWatch.lookbackMinutes"],
		["an unknown level", { minLevel: "info" }, "errorWatch.minLevel"],
		["a non-boolean enabled", { enabled: "yes" }, "errorWatch.enabled"],
		["an unknown key", { quiet: true }, "errorWatch.quiet"],
		["an unknown provider", { providers: { loki: {} } }, "errorWatch.providers.loki"],
		["empty tracks", { providers: { datadog: { tracks: [] } } }, "errorWatch.providers.datadog.tracks"],
		["a non-array include", { providers: { sentry: { projects: { include: "web" } } } }, "errorWatch.providers.sentry.projects.include"],
		["a repo without a repo key", { repos: { svc: { branch: "main" } } }, "errorWatch.repos.svc.repo"],
		["a repo on another host", { repos: { svc: { repo: "gitlab.example.com/o/r" } } }, "errorWatch.repos.svc.repo"],
		["a malformed repo", { repos: { svc: { repo: "o/r" } } }, "errorWatch.repos.svc.repo"],
		["a zero cap", { autoFix: { maxPerHour: 0 } }, "errorWatch.autoFix.maxPerHour"],
		["a fractional cap", { autoFix: { maxPerHour: 1.5 } }, "errorWatch.autoFix.maxPerHour"],
		["a zero fix timeout", { autoFix: { timeoutMinutes: 0 } }, "errorWatch.autoFix.timeoutMinutes"],
		["a non-boolean repo autoFix", { repos: { svc: { repo: "github.com/o/r", autoFix: "no" } } }, "errorWatch.repos.svc.autoFix"],
	])("rejects %s", (_name, errorWatch, key) => {
		expect(failure({ errorWatch })).toContain(key);
	});

	test("accepts a repo on a configured GitHub host", () => {
		const watch = load({
			hosts: { github: ["ghe.example.com"] },
			errorWatch: { repos: { svc: { repo: "ghe.example.com/o/r" } } },
		}).errorWatch;
		expect(watch.repos.svc?.repo).toBe("ghe.example.com/o/r");
	});
});

describe("loadConfig deps", () => {
	test("defaults to off with a weekly schedule", () => {
		expect(load().deps).toMatchObject({
			enabled: false,
			timeoutMinutes: 90,
			ciTimeoutMinutes: 60,
			cooldownDays: 7,
			branchPrefix: "chore/deps-update-",
			schedule: { every: "week", day: "mon", window: "02:00-05:00" },
			repos: [],
		});
	});

	test("takes a custom deps branch prefix", () => {
		expect(load({ deps: { branchPrefix: "me/chore/deps-" } }).deps.branchPrefix).toBe("me/chore/deps-");
	});

	test("accepts a zero cooldown to turn it off", () => {
		expect(load({ deps: { cooldownDays: 0 } }).deps.cooldownDays).toBe(0);
	});

	test("adds the deps-upgrade tools to the fix allowlist base", () => {
		const tools = load().deps.allowedTools;
		expect(tools).toContain("Read(~/.claude/skills/deps-upgrade/**)");
		expect(tools).toContain(`Bash(${homedir()}/scripts/bin/deps-upgrade-helper:*)`);
		expect(tools).toContain("Bash(git:*)");
		expect(tools).toContain("Bash(gh:*)");
		expect(tools).toContain("Bash(git status:*)");
		expect(tools).toContain(`Edit(/${home.dir}/channel-review/clones/**)`);
	});

	test("reads repos with their own schedule overrides", () => {
		const { deps } = load({
			deps: {
				enabled: true,
				timeoutMinutes: 30,
				ciTimeoutMinutes: 20,
				schedule: { every: "day", day: "fri", window: "01:00-03:30" },
				repos: [
					{ repo: "github.com/example-org/app", branch: "develop", schedule: { day: "sun" } },
					{ repo: "github.com/example-org/lib" },
				],
			},
		});
		expect(deps).toMatchObject({
			enabled: true,
			timeoutMinutes: 30,
			ciTimeoutMinutes: 20,
			schedule: { every: "day", day: "fri", window: "01:00-03:30" },
		});
		expect(deps.repos[0]).toMatchObject({ repo: "github.com/example-org/app", branch: "develop", schedule: { day: "sun" } });
		expect(deps.repos[1]?.schedule).toEqual({ every: undefined, day: undefined, window: undefined });
	});

	test.each([
		["a zero timeout", { timeoutMinutes: 0 }, "deps.timeoutMinutes"],
		["a zero CI timeout", { ciTimeoutMinutes: 0 }, "deps.ciTimeoutMinutes"],
		["a negative cooldown", { cooldownDays: -1 }, "deps.cooldownDays"],
		["a fractional cooldown", { cooldownDays: 1.5 }, "deps.cooldownDays"],
		["a non-boolean enabled", { enabled: 1 }, "deps.enabled"],
		["an unknown key", { quiet: true }, "deps.quiet"],
		["an unknown cadence", { schedule: { every: "year" } }, "deps.schedule.every"],
		["an unknown day", { schedule: { day: "funday" } }, "deps.schedule.day"],
		["a malformed window", { schedule: { window: "2am" } }, "deps.schedule.window"],
		["a non-array repos", { repos: {} }, "deps.repos"],
		["a repo without a repo key", { repos: [{ branch: "main" }] }, "deps.repos[0].repo"],
		["a repo on another host", { repos: [{ repo: "gitlab.example.com/o/r" }] }, "deps.repos[0].repo"],
		["a duplicate repo", { repos: [{ repo: "github.com/o/r" }, { repo: "github.com/o/r" }] }, "deps.repos"],
		["a bad repo schedule", { repos: [{ repo: "github.com/o/r", schedule: { window: "x" } }] }, "deps.repos[0].schedule.window"],
	])("rejects %s", (_name, deps, key) => {
		expect(failure({ deps })).toContain(key);
	});
});
