import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "../src/daemon";
import { RelayAuthError } from "../src/providers/teams-relay";
import { type DaemonHarness, createDaemonHarness } from "./daemon-harness";

const harnesses: DaemonHarness[] = [];

function setup(options: Parameters<typeof createDaemonHarness>[0] = {}) {
	const harness = createDaemonHarness(options);
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("connect", () => {
	test("fetches the secret with the env's AWS profile and the configured secret location", async () => {
		const h = setup({ envName: "prod" });
		await connect({ config: h.config, env: h.env, overrides: {}, seams: h.seams });
		expect(h.fetchSecretCalls).toEqual([
			{
				profile: "example-prod",
				region: h.config.relay.secret.region,
				id: h.config.relay.secret.id,
				key: h.config.relay.secret.key,
			},
		]);
	});

	test("builds the provider with the fetched secret and returns secret, provider, and chats", async () => {
		const h = setup();
		const result = await connect({ config: h.config, env: h.env, overrides: {}, seams: h.seams });
		expect(h.providerSecrets).toEqual(["secret-1"]);
		expect(result.secret).toBe("secret-1");
		expect(result.provider).toBe(h.provider());
		expect(result.chats).toEqual([{ id: "chat-1", topic: "Team Reviews" }]);
	});

	test("resolves the chat from the configured topic when no id is set", async () => {
		const h = setup();
		await connect({ config: h.config, env: h.env, overrides: {}, seams: h.seams });
		expect(h.provider().resolveRequests).toEqual([
			{ chatId: undefined, topic: "Team Reviews" },
		]);
	});

	test("the configured chat id is passed to resolveChat", async () => {
		const h = setup({ configExtra: { chat: { id: "19:cfg@thread.v2" } } });
		await connect({ config: h.config, env: h.env, overrides: {}, seams: h.seams });
		expect(h.provider().resolveRequests[0]?.chatId).toBe("19:cfg@thread.v2");
	});

	test("an override chat id replaces the configured chats", async () => {
		const h = setup({ configExtra: { chat: { id: "19:cfg@thread.v2" } } });
		const { chats } = await connect({
			config: h.config,
			env: h.env,
			overrides: { chatId: "19:flag@thread.v2" },
			seams: h.seams,
		});
		expect(h.provider().resolveRequests[0]?.chatId).toBe("19:flag@thread.v2");
		expect(chats.map((chat) => chat.id)).toEqual(["19:flag@thread.v2"]);
		expect(h.provider().resolveRequests).toHaveLength(1);
	});

	test("resolves every configured chat", async () => {
		const h = setup({
			configExtra: { chats: [{ id: "19:a@thread.v2" }, { id: "19:b@thread.v2" }] },
		});
		const { chats } = await connect({ config: h.config, env: h.env, overrides: {}, seams: h.seams });
		expect(chats.map((chat) => chat.id)).toEqual(["19:a@thread.v2", "19:b@thread.v2"]);
		expect(h.provider().resolveRequests.map((request) => request.chatId)).toEqual([
			"19:a@thread.v2",
			"19:b@thread.v2",
		]);
	});

	test("rejects when two configured chats resolve to the same id", async () => {
		const h = setup({ configExtra: { chats: [{ topic: "A" }, { topic: "B" }] } });
		await expect(
			connect({ config: h.config, env: h.env, overrides: {}, seams: h.seams }),
		).rejects.toThrow("chat-1");
	});

	test("an RelayAuthError names the secret remedy and does not fetch the secret a second time", async () => {
		const h = setup({ resolveError: new RelayAuthError(401) });
		await expect(
			connect({ config: h.config, env: h.env, overrides: {}, seams: h.seams }),
		).rejects.toThrow(/secret/i);
		expect(h.secrets).toHaveLength(1);
	});

	test("a secret fetch failure rejects with its message", async () => {
		const h = setup();
		h.seams.fetchSecret = async () => {
			throw new Error("AWS SSO session expired");
		};
		await expect(
			connect({ config: h.config, env: h.env, overrides: {}, seams: h.seams }),
		).rejects.toThrow("AWS SSO session expired");
	});
});
