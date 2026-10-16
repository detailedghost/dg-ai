import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { status } from "../src/daemon";
import type { PreflightReport } from "../src/providers/teams-relay";
import {
	DAEMON_ARGS,
	type DaemonHarness,
	type DaemonHarnessOptions,
	createDaemonHarness,
} from "./daemon-harness";
import { ENVS } from "./support/fakes";

const harnesses: DaemonHarness[] = [];

function setup(options: DaemonHarnessOptions = {}): DaemonHarness {
	const harness = createDaemonHarness(options);
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

type PreflightCall = { config: unknown; env: { name: string; baseUrl: string; awsProfile: string } };

function okReport(env: string): PreflightReport {
	return { env, secret: "ok", chats: [{ id: "chat-1" }], reactions: "ok", funPool: "ok" };
}

function run(h: DaemonHarness, flag?: string, report?: (env: string) => PreflightReport) {
	const calls: PreflightCall[] = [];
	const result = status(
		{ env: flag },
		{
			system: h.system,
			platform: h.platform,
			io: h.io,
			runners: h.runners,
			probeTimeoutMs: 50,
			preflight: async (call: PreflightCall) => {
				calls.push(call);
				return (report ?? okReport)(call.env.name);
			},
		},
	);
	return { calls, result };
}

function printed(h: DaemonHarness): Record<string, any> {
	return JSON.parse(h.io.outLines.join("\n"));
}

describe("status", () => {
	test("prints env dev, running false, and a preflight block when nothing runs", async () => {
		const h = setup();
		const { calls, result } = run(h);
		expect(await result).toBe(0);
		expect(calls).toHaveLength(1);
		expect(printed(h)).toMatchObject({
			env: "dev",
			running: false,
			logPath: h.paths.logPath,
			preflight: { secret: "ok", chats: [{ id: "chat-1" }], reactions: "ok" },
		});
	});

	test("keeps pid and startedAt as null and chats empty when nothing runs", async () => {
		const h = setup();
		await run(h).result;
		const body = printed(h);
		expect(body.chats).toEqual([]);
		for (const key of ["pid", "startedAt"]) {
			expect(body).toHaveProperty(key, null);
		}
	});

	test("prints the $address sender gate with a count of sender ids only", async () => {
		const h = setup({
			configExtra: {
				owner: { token: "!owner", email: "owner@example.com", senderIds: ["u-owner", "u-other"] },
				address: { allowAnySender: true },
			},
		});
		await run(h).result;
		expect(printed(h).address).toBe("allowAnySender true, senderIds 2");
		expect(h.io.outLines.join("\n")).not.toContain("u-owner");
	});

	test("reports a runner probe that never settles as a timeout", async () => {
		const h = setup();
		h.runners.copilot.probe = () => new Promise(() => undefined);
		await run(h).result;
		expect(printed(h).runners.copilot).toBe("timeout");
	});

	test("reports a missing env setting as a config error naming the key, exit 1", async () => {
		const h = setup({ configExtra: { envs: { dev: ENVS.dev } } });
		const { result } = run(h, "prod");
		expect(await result).toBe(1);
		const body = printed(h);
		expect(body).toMatchObject({ env: "prod", running: false });
		expect(body.preflight.config.error).toBe("envs.prod.baseUrl is required");
	});

	test("status --env prod names env prod and preflights with the prod base URL and profile", async () => {
		const h = setup({ envName: "dev" });
		const { calls, result } = run(h, "prod");
		await result;
		expect(calls[0]?.env).toMatchObject({
			name: "prod",
			baseUrl: ENVS.prod.baseUrl,
			awsProfile: "example-prod",
		});
		const body = printed(h);
		expect(body.env).toBe("prod");
		expect(body.logPath).toBe(h.pathsFor("prod").logPath);
	});

	test("a running dev daemon does not make prod report running", async () => {
		const h = setup();
		h.writePidfile(4242, "dev");
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, DAEMON_ARGS);
		const { result } = run(h, "prod");
		await result;
		expect(printed(h)).toMatchObject({ env: "prod", running: false });
	});

	test("uses env.default from config when no flag is given", async () => {
		const h = setup({ configExtra: { env: { default: "prod" } } });
		const { result } = run(h);
		await result;
		expect(printed(h).env).toBe("prod");
	});

	test("a live daemon reports pid, chats, lastEventIds, and skips preflight", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, DAEMON_ARGS);
		h.seedState((store) => store.setLastEventId("chat-1", "e9"));
		const { calls, result } = run(h);
		expect(await result).toBe(0);
		expect(calls).toHaveLength(0);
		expect(printed(h)).toMatchObject({
			env: "dev",
			running: true,
			pid: 4242,
			chats: [{ id: "chat-1", topic: "Team Reviews" }],
			lastEventIds: { "chat-1": "e9" },
			startedAt: "2026-10-14T12:00:00.000Z",
		});
		expect(printed(h).preflight).toBeUndefined();
	});

	test("reads a pidfile written before chats existed", async () => {
		const h = setup();
		writeFileSync(
			h.paths.pidPath,
			JSON.stringify({ pid: 4242, chatId: "chat-1", chatTopic: "Team Reviews" }),
		);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, DAEMON_ARGS);
		const { result } = run(h);
		await result;
		expect(printed(h).chats).toEqual([{ id: "chat-1", topic: "Team Reviews" }]);
	});

	test("a pidfile whose pid is not our daemon reports running false", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, "/usr/bin/vim");
		const { result } = run(h);
		await result;
		expect(printed(h).running).toBe(false);
	});

	test("reports the current job from the state file", async () => {
		const h = setup();
		const current = {
			messageId: "m1",
			url: "https://github.com/o/r/pull/12",
			number: 12,
			startedAt: "2026-10-14T12:00:00.000Z",
		};
		h.seedState((store) => store.setCurrent(current));
		const { result } = run(h);
		await result;
		expect(printed(h).current).toEqual(current);
	});

	test("reports every runner probe as ok or its CR code", async () => {
		const h = setup();
		h.runners.codex.probeResult = { ok: false, code: "CR-201" };
		h.runners.copilot.probeResult = { ok: false, code: "CR-206" };
		const { result } = run(h);
		await result;
		expect(printed(h).runners).toEqual({ claude: "ok", codex: "CR-201", copilot: "CR-206" });
	});

	test("exits 0 when the only finding is a dropped fun pool emoji", async () => {
		const h = setup();
		const { result } = run(h, undefined, (env) => ({
			...okReport(env),
			funPool: { dropped: ["fun.pool[8].reactionId 1f680_rocket"] },
		}));
		expect(await result).toBe(0);
	});

	test("exits 1 when any preflight check reports an error", async () => {
		const h = setup();
		const { result } = run(h, undefined, (env) => ({
			env,
			secret: "ok",
			chats: [{ id: "chat-1" }, { error: "chat-2: Review Bot is not a member of this chat" }],
			reactions: "skipped",
			funPool: "skipped",
		}));
		expect(await result).toBe(1);
		expect(printed(h).preflight.chats[1]).toEqual({
			error: "chat-2: Review Bot is not a member of this chat",
		});
	});

	test("without config.json it prints running false and a config error naming the path, exits 1, and never preflights", async () => {
		const h = setup({ writeConfig: false });
		const { calls, result } = run(h);
		expect(await result).toBe(1);
		expect(calls).toHaveLength(0);
		const body = printed(h);
		expect(body.running).toBe(false);
		expect(body.preflight.config.error).toContain(h.paths.configPath);
	});

	test("an invalid config file never throws and exits 1", async () => {
		const h = setup();
		writeFileSync(h.paths.configPath, "{not json");
		const { result } = run(h);
		expect(await result).toBe(1);
		expect(printed(h).preflight.config.error).toContain(h.paths.configPath);
	});

	test("a throwing preflight is reported and never escapes", async () => {
		const h = setup();
		const result = status(
			{},
			{
				system: h.system,
				platform: h.platform,
				io: h.io,
				runners: h.runners,
				preflight: async () => {
					throw new Error("boom");
				},
			},
		);
		expect(await result).toBe(1);
	});

	test("reports error watch and deps state with env names only", async () => {
		const h = setup({
			configExtra: {
				errorWatch: { enabled: true, providers: { datadog: { enabled: true } } },
				deps: { enabled: true, repos: [{ repo: "github.com/example-org/app" }] },
			},
		});
		h.seedState((store) => {
			store.updateSink("datadog", { lastPollAt: "2026-10-14T12:00:00.000Z", counts: { polled: 3 } });
			store.recordDepsRun("github.com/example-org/app", { windowStart: "w", result: "ready" });
			store.watchPr("https://github.com/example-org/app/pull/1", {
				repo: "github.com/example-org/app",
				kind: "deps",
			});
		});
		const result = status(
			{},
			{
				system: h.system,
				platform: h.platform,
				io: h.io,
				runners: h.runners,
				probeTimeoutMs: 50,
				env: { DATADOG_API_KEY: "secret-value" },
				preflight: async (call: PreflightCall) => okReport(call.env.name),
			},
		);
		expect(await result).toBe(0);
		const body = printed(h);
		expect(body.errorWatch).toEqual({
			enabled: true,
			providers: {
				datadog: {
					enabled: true,
					lastPollAt: "2026-10-14T12:00:00.000Z",
					lastError: null,
					counts: { polled: 3 },
				},
				sentry: { enabled: false, lastPollAt: null, lastError: null, counts: {} },
			},
			missingEnv: ["DATADOG_ACCESS_TOKEN", "DATADOG_APP_KEY"],
		});
		expect(body.deps).toMatchObject({ enabled: true, repos: 1, watchingPrs: 1 });
		expect(body.deps.lastRun["github.com/example-org/app"].result).toBe("ready");
		expect(h.io.all()).not.toContain("secret-value");
	});
});
