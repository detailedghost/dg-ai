import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startChatRegistration } from "../src/daemon/register";
import { loadConfig, resolveEnv } from "../src/config";
import { createTeamsRelayProvider } from "../src/providers/teams-relay";
import type { ChatProvider } from "../src/providers/types";
import {
	APP_NAME,
	createRecordedLog,
	createTempHome,
	minimalConfigJson,
	type TempHome,
	writeConfigFile,
} from "./support/fakes";

const DAY_MS = 24 * 3_600_000;
const GROUP_CHAT = "19:abc123@thread.v2";
const API_CODE = Buffer.from(`${APP_NAME}:s3cret`).toString("base64");

type Call = { url: string; method: string; headers: Headers; body: string };

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => {
	home.cleanup();
});

function createHarness(respond: (call: Call) => Response | Error = () => new Response(null, { status: 201 })) {
	const config = loadConfig(writeConfigFile(home.dir, minimalConfigJson()));
	const env = resolveEnv(config);
	const calls: Call[] = [];
	const log = createRecordedLog();
	const provider = createTeamsRelayProvider(config, env, {
		fetch: (async (input: unknown, init: RequestInit = {}) => {
			const call = {
				url: String(input),
				method: init.method ?? "GET",
				headers: new Headers(init.headers),
				body: String(init.body ?? ""),
			};
			calls.push(call);
			const result = respond(call);
			if (result instanceof Error) throw result;
			return result;
		}) as typeof fetch,
		secret: "s3cret",
		log,
	});
	return { env, calls, log, provider };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const request = { chatId: GROUP_CHAT, env: "dev", version: "1.2.3" };

describe("registerChat", () => {
	test("sends a PUT with the API code and the registration body", async () => {
		const { calls, env, provider } = createHarness();

		await provider.registerChat(request);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.method).toBe("PUT");
		expect(call?.url).toBe(
			`${env.baseUrl}/chat/${encodeURIComponent(GROUP_CHAT)}/register`,
		);
		expect(call?.headers.get("X-Api-Code")).toBe(API_CODE);
		expect(call?.headers.get("Content-Type")).toBe("application/json");
		expect(JSON.parse(call?.body ?? "")).toEqual({
			service: "channel-review",
			env: "dev",
			version: "1.2.3",
			repo: "detailedghost/dg-ai",
		});
	});

	test("encodes the chat id in the path", async () => {
		const { calls, provider } = createHarness();

		await provider.registerChat({ ...request, chatId: "19:a/b?c@thread.v2" });

		expect(calls[0]?.url).toEndWith("/chat/19%3Aa%2Fb%3Fc%40thread.v2/register");
	});

	test.each([200, 201])("logs nothing when the relay answers %i", async (code) => {
		const { log, provider } = createHarness(() => new Response("{}", { status: code }));

		await provider.registerChat(request);

		expect(log.lines).toEqual([]);
	});

	test("logs an error on HTTP 400", async () => {
		const { log, provider } = createHarness(() => new Response(null, { status: 400 }));

		await provider.registerChat(request);

		expect(log.lines).toEqual([
			{ level: "error", message: expect.stringContaining("HTTP 400") },
		]);
	});

	test("logs a warning on HTTP 404", async () => {
		const { log, provider } = createHarness(() => new Response(null, { status: 404 }));

		await provider.registerChat(request);

		expect(log.lines).toEqual([
			{ level: "warn", message: expect.stringContaining("not a member") },
		]);
	});

	test("logs a warning on HTTP 500", async () => {
		const { log, provider } = createHarness(() => new Response(null, { status: 500 }));

		await provider.registerChat(request);

		expect(log.lines).toEqual([
			{ level: "warn", message: expect.stringContaining("HTTP 500") },
		]);
	});

	test("logs a warning and resolves when the network fails", async () => {
		const { log, provider } = createHarness(() => new Error("socket closed"));

		await provider.registerChat(request);

		expect(log.lines).toEqual([
			{ level: "warn", message: expect.stringContaining("socket closed") },
		]);
	});

	test.each([401, 403])("logs a warning without throwing on HTTP %i", async (code) => {
		const { log, provider } = createHarness(() => new Response(null, { status: code }));

		await provider.registerChat(request);

		expect(log.lines).toEqual([
			{ level: "warn", message: expect.stringContaining("API code") },
		]);
		expect(JSON.stringify(log.lines)).not.toContain("s3cret");
	});
});

describe("startChatRegistration", () => {
	function run(chats: { id: string }[]) {
		const registered: string[] = [];
		const controller = new AbortController();
		const waits: { ms: number; release: () => void }[] = [];
		const done = startChatRegistration({
			provider: {
				registerChat: async ({ chatId }: { chatId: string }) => {
					registered.push(chatId);
				},
			} as Pick<ChatProvider, "registerChat"> as ChatProvider,
			chats,
			env: "dev",
			version: "1.2.3",
			signal: controller.signal,
			sleep: (ms, signal) =>
				new Promise<void>((resolve) => {
					waits.push({ ms, release: resolve });
					signal?.addEventListener("abort", () => resolve(), { once: true });
				}),
		});
		return { registered, controller, waits, done };
	}

	test("registers each chat once on start", async () => {
		const { registered, controller, done } = run([{ id: "a" }, { id: "b" }]);
		await flush();

		expect(registered).toEqual(["a", "b"]);
		controller.abort();
		await done;
	});

	test("registers again after 24 hours", async () => {
		const { registered, waits, controller, done } = run([{ id: "a" }]);
		await flush();
		expect(waits.map(({ ms }) => ms)).toEqual([DAY_MS]);

		waits[0]?.release();
		await flush();

		expect(registered).toEqual(["a", "a"]);
		controller.abort();
		await done;
	});

	test("stops registering when the signal aborts", async () => {
		const { registered, controller, done } = run([{ id: "a" }]);
		await flush();

		controller.abort();
		await done;

		expect(registered).toEqual(["a"]);
	});
});
