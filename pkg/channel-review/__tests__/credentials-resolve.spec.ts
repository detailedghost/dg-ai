import { afterEach, describe, expect, test } from "bun:test";
import { DgCliError } from "@dg/common";
import { DaemonNotRunningError } from "@dg/common/node";
import { resolveSecrets } from "../src/credentials";
import { status } from "../src/daemon";
import type { PreflightReport } from "../src/providers/teams-relay";
import { createDaemonHarness, type DaemonHarness } from "./daemon-harness";
import { createFakeCredentialSource, waitUntil } from "./support/fakes";

const STORE_RELAY = "fixture-store-relay-7f1c";
const ENV_RELAY = "fixture-env-relay-2b9d";
const STORE_DATADOG = "ddpat_fixtureStoreDatadogValue0123";
const STORE_SENTRY = "fixture-store-sentry-41aa";

const harnesses: DaemonHarness[] = [];

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("resolveSecrets", () => {
	test("prefers the store over env and copies site and org from meta", async () => {
		const source = createFakeCredentialSource({
			"channel-review/relay/dev": { value: STORE_RELAY },
			"channel-review/datadog": {
				value: STORE_DATADOG,
				meta: {
					site: "us5.datadoghq.com",
					expiresAt: "2027-10-01T00:00:00.000Z",
				},
			},
			"channel-review/sentry": {
				value: STORE_SENTRY,
				meta: { site: "https://sentry.example.test", org: "example-org" },
			},
		});
		const resolved = await resolveSecrets({
			envName: "dev",
			env: {
				CHANNEL_REVIEW_RELAY_SECRET_DEV: ENV_RELAY,
				DATADOG_ACCESS_TOKEN: "env-datadog",
				DATADOG_SITE: "datadoghq.eu",
				SENTRY_ORG: "env-org",
			},
			source,
		});
		expect(resolved.env).toMatchObject({
			CHANNEL_REVIEW_RELAY_SECRET_DEV: STORE_RELAY,
			DATADOG_ACCESS_TOKEN: STORE_DATADOG,
			DATADOG_SITE: "us5.datadoghq.com",
			SENTRY_AUTH_TOKEN: STORE_SENTRY,
			SENTRY_BASE_URL: "https://sentry.example.test",
			SENTRY_ORG: "example-org",
		});
		expect(resolved.secrets).toEqual({
			relay: { name: "channel-review/relay/dev", source: "store" },
			datadog: {
				name: "channel-review/datadog",
				source: "store",
				expiresAt: "2027-10-01T00:00:00.000Z",
			},
			sentry: { name: "channel-review/sentry", source: "store" },
		});
		expect(resolved.warning).toBeUndefined();
		expect(source.closed).toBe(1);
	});

	test("skips an expired store record so a valid env value is used", async () => {
		const resolved = await resolveSecrets({
			envName: "dev",
			env: { DATADOG_ACCESS_TOKEN: "env-datadog" },
			source: createFakeCredentialSource({
				"channel-review/datadog": {
					value: STORE_DATADOG,
					meta: { expiresAt: "2026-09-01T00:00:00.000Z" },
				},
			}),
			now: () => new Date("2026-10-01T00:00:00.000Z"),
		});
		expect(resolved.env.DATADOG_ACCESS_TOKEN).toBe("env-datadog");
		expect(resolved.secrets.datadog).toEqual({
			name: "channel-review/datadog",
			source: "env",
			expiresAt: "2026-09-01T00:00:00.000Z",
			expired: true,
		});
		expect(resolved.warning).toContain("channel-review/datadog");
	});

	test("ignores a non-string expiresAt", async () => {
		const resolved = await resolveSecrets({
			envName: "dev",
			env: {},
			source: createFakeCredentialSource({
				"channel-review/sentry": {
					value: STORE_SENTRY,
					meta: { expiresAt: 5 as unknown as string },
				},
			}),
		});
		expect(resolved.secrets.sentry).toEqual({
			name: "channel-review/sentry",
			source: "store",
		});
	});

	test("falls back to env when the store has no entry", async () => {
		const resolved = await resolveSecrets({
			envName: "prod",
			env: {
				CHANNEL_REVIEW_RELAY_SECRET_PROD: ENV_RELAY,
				DATADOG_API_KEY: "env-api",
				DATADOG_APP_KEY: "env-app",
				SENTRY_AUTH_TOKEN: "env-sentry",
			},
			source: createFakeCredentialSource(),
		});
		expect(resolved.env.CHANNEL_REVIEW_RELAY_SECRET_PROD).toBe(ENV_RELAY);
		expect(resolved.secrets.relay).toEqual({
			name: "channel-review/relay/prod",
			source: "env",
		});
		expect(resolved.secrets.datadog.source).toBe("env");
		expect(resolved.secrets.sentry.source).toBe("env");
	});

	test("reports aws for the relay and missing for the sinks when neither store nor env has them", async () => {
		const resolved = await resolveSecrets({
			envName: "dev",
			env: { DATADOG_API_KEY: "env-api" },
			source: createFakeCredentialSource(),
		});
		expect(resolved.env.CHANNEL_REVIEW_RELAY_SECRET_DEV).toBeUndefined();
		expect(resolved.secrets.relay.source).toBe("aws");
		expect(resolved.secrets.datadog.source).toBe("missing");
		expect(resolved.secrets.sentry.source).toBe("missing");
	});

	test("reads only entries the list shows", async () => {
		const source = createFakeCredentialSource({
			"channel-review/datadog": { value: STORE_DATADOG },
		});
		await resolveSecrets({ envName: "dev", env: {}, source });
		expect(source.gets).toEqual(["channel-review/datadog"]);
	});

	test("warns with the grant fix and falls back to env when the grant is missing", async () => {
		const resolved = await resolveSecrets({
			envName: "dev",
			env: { CHANNEL_REVIEW_RELAY_SECRET_DEV: ENV_RELAY },
			source: createFakeCredentialSource(
				{ "channel-review/relay/dev": { value: STORE_RELAY } },
				new DgCliError(
					"no credential grant for channel-review; run dg-skills credentials grant channel-review",
				),
			),
		});
		expect(resolved.env.CHANNEL_REVIEW_RELAY_SECRET_DEV).toBe(ENV_RELAY);
		expect(resolved.secrets.relay.source).toBe("env");
		expect(resolved.warning).toContain("dg-agent start");
		expect(resolved.warning).toContain(
			"dg-skills credentials grant channel-review",
		);
		expect(resolved.warning).not.toContain(ENV_RELAY);
	});

	test("warns and falls back to env when dg-daemon is not running", async () => {
		const resolved = await resolveSecrets({
			envName: "dev",
			env: { SENTRY_AUTH_TOKEN: "env-sentry" },
			source: createFakeCredentialSource({}, new DaemonNotRunningError()),
		});
		expect(resolved.warning).toContain("dg-daemon is not running");
		expect(resolved.secrets.sentry.source).toBe("env");
	});
});

describe("daemon credential wiring", () => {
	test("serve connects with the stored relay secret and skips AWS", async () => {
		const h = createDaemonHarness();
		harnesses.push(h);
		h.seams.credentials = createFakeCredentialSource({
			"channel-review/relay/dev": { value: STORE_RELAY },
		});
		const { controller, done } = h.startServe();
		await waitUntil(
			() =>
				h.providers.length > 0 &&
				h.log.lines.some((line) => line.message.includes("daemon started")),
		);
		controller.abort();
		await done;
		expect(h.providerSecrets).toEqual([STORE_RELAY]);
		expect(h.fetchSecretCalls).toEqual([]);
		expect(JSON.stringify(h.log.lines)).not.toContain(STORE_RELAY);
	});

	test("serve logs the store warning and falls back to env", async () => {
		const h = createDaemonHarness();
		harnesses.push(h);
		h.seams.env = { CHANNEL_REVIEW_RELAY_SECRET_DEV: ENV_RELAY };
		h.seams.credentials = createFakeCredentialSource(
			{},
			new DaemonNotRunningError(),
		);
		const { controller, done } = h.startServe();
		await waitUntil(() => h.providers.length > 0);
		controller.abort();
		await done;
		expect(h.providerSecrets).toEqual([ENV_RELAY]);
		const warnings = h.log.lines
			.filter((line) => line.level === "warn")
			.map((line) => line.message);
		expect(
			warnings.some((line) =>
				line.includes("dg-skills credentials grant channel-review"),
			),
		).toBe(true);
	});

	test("status prints each secret source and expiresAt without values", async () => {
		const h = createDaemonHarness();
		harnesses.push(h);
		const code = await status(
			{},
			{
				system: h.system,
				platform: h.platform,
				io: h.io,
				runners: h.runners,
				probeTimeoutMs: 50,
				env: { SENTRY_AUTH_TOKEN: "env-sentry-value" },
				credentials: createFakeCredentialSource({
					"channel-review/relay/dev": { value: STORE_RELAY },
					"channel-review/datadog": {
						value: STORE_DATADOG,
						meta: { expiresAt: "2027-10-01T00:00:00.000Z" },
					},
				}),
				preflight: async ({ env, secret }): Promise<PreflightReport> => {
					expect(secret).toBe(STORE_RELAY);
					return {
						env: env.name,
						secret: "ok",
						chats: [{ id: "chat-1" }],
						reactions: "ok",
						funPool: "ok",
					};
				},
			},
		);
		expect(code).toBe(0);
		const output = h.io.outLines.join("\n");
		expect(JSON.parse(output).credentials).toEqual({
			relay: { name: "channel-review/relay/dev", source: "store" },
			datadog: {
				name: "channel-review/datadog",
				source: "store",
				expiresAt: "2027-10-01T00:00:00.000Z",
			},
			sentry: { name: "channel-review/sentry", source: "env" },
		});
		expect(output).not.toContain(STORE_DATADOG);
		expect(output).not.toContain(STORE_RELAY);
		expect(output).not.toContain("env-sentry-value");
	});
});
