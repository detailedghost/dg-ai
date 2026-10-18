import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { CredentialGrantSummary, CredentialMeta } from "@dg/common";
import {
	type BrowserSession,
	type ConnectDeps,
	type ConnectFlags,
	type ConnectProvider,
	runConnect,
	type UiLocator,
	type UiPage,
} from "../src/commands/channel-review-connect";
import { promptHidden } from "../src/commands/credentials";

const DATADOG_TOKEN = "ddpat_fixtureDatadogToken0123456789abcdef";
const SENTRY_TOKEN = "sntryu_fixtureSentryToken0123456789abcdef";
const RELAY_SECRET = "fixture-relay-secret-5e2a";
const NOW = new Date("2026-10-16T12:00:00.000Z");

type PageOptions = {
	urls: string[];
	clipboard?: string;
	domToken?: string | null;
	failOn?: RegExp;
	rows?: string[];
};

function createFakeSession(options: PageOptions) {
	const actions: string[] = [];
	const gotos: string[] = [];
	const evaluations: string[] = [];
	const grants: string[] = [];
	let closed = 0;
	const urls = [...options.urls];
	const act = async (path: string, action: string) => {
		actions.push(`${path}.${action}`);
		if (options.failOn?.test(path))
			throw new Error(`locator ${path} timed out\ncall log`);
	};
	const locate = (path: string): UiLocator => ({
		first: () => locate(`${path}.first`),
		last: () => locate(`${path}.last`),
		or: (other) =>
			locate(`${path}|${(other as UiLocator & { path: string }).path}`),
		filter: ({ hasText }) => locate(`${path}[${String(hasText)}]`),
		getByRole: (role, aria) =>
			locate(
				`${path} role=${role}${aria?.name ? `(${String(aria.name)})` : ""}`,
			),
		getByLabel: (text) => locate(`${path} label=${String(text)}`),
		getByPlaceholder: (text) => locate(`${path} placeholder=${String(text)}`),
		locator: (selector) => locate(`${path} ${selector}`),
		click: () => act(path, "click"),
		fill: (value) => act(path, `fill(${value})`),
		count: async () => 1,
		allInnerTexts: async () => options.rows ?? [],
		isVisible: async () => true,
		...({ path } as object),
	});
	const root = locate("page");
	const page: UiPage = {
		getByRole: root.getByRole,
		getByLabel: root.getByLabel,
		getByPlaceholder: root.getByPlaceholder,
		locator: root.locator,
		goto: async (url) => {
			gotos.push(url);
		},
		url: () =>
			urls.length > 1 ? (urls.shift() as string) : (urls[0] as string),
		evaluate: async (expression) => {
			evaluations.push(expression);
			if (expression.includes("readText")) return options.clipboard;
			if (expression.includes("writeText")) return undefined;
			return options.domToken ?? null;
		},
	};
	const session: BrowserSession = {
		page,
		grantClipboard: async (origin) => {
			grants.push(origin);
		},
		close: async () => {
			closed += 1;
		},
	};
	return {
		session,
		actions,
		gotos,
		evaluations,
		grants,
		closed: () => closed,
		cleared: () =>
			evaluations.filter((expression) => expression.includes('writeText("")'))
				.length,
	};
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(
	options: {
		page?: PageOptions;
		pasted?: string;
		grants?: CredentialGrantSummary[];
		status?: number;
		failSet?: boolean;
	} = {},
) {
	const lines: string[] = [];
	const sets: { name: string; value: string; meta?: CredentialMeta }[] = [];
	const granted: string[] = [];
	const opened: string[] = [];
	const prompts: string[] = [];
	const requests: { url: string; init: RequestInit }[] = [];
	const relayCalls: unknown[] = [];
	let launches = 0;
	let clientClosed = 0;
	let setFailed = false;
	const fake = createFakeSession(
		options.page ?? { urls: ["https://app.datadoghq.com/"] },
	);
	const deps: ConnectDeps = {
		createClient: () => ({
			set: async (name, value, meta) => {
				if (options.failSet && sets.length === 0 && !setFailed) {
					setFailed = true;
					throw new Error("store failed");
				}
				fake.actions.push("STORE");
				sets.push({ name, value, meta });
			},
			listGrants: async () => options.grants ?? [],
			grant: async (prefix) => {
				granted.push(prefix);
				return { prefix, path: `/fixture/grants/${prefix}.token` };
			},
			close: () => {
				clientClosed += 1;
			},
		}),
		launchBrowser: async () => {
			launches += 1;
			return fake.session;
		},
		openExternal: async (url) => {
			opened.push(url);
		},
		readSecret: async (prompt) => {
			prompts.push(prompt);
			return options.pasted ?? "";
		},
		relayTarget: (env) => ({
			envName: env ?? "dev",
			params: {
				profile: "example-dev",
				region: "us-east-1",
				id: "relay/chat",
				key: "KEY",
			},
		}),
		fetchRelaySecret: async (params) => {
			relayCalls.push(params);
			return RELAY_SECRET;
		},
		fetch: async (url, init) => {
			requests.push({ url, init });
			return new Response("{}", { status: options.status ?? 200 });
		},
		write: (line) => lines.push(line),
		now: () => NOW,
		sleep: async () => undefined,
	};
	return {
		deps,
		fake,
		lines,
		sets,
		granted,
		opened,
		prompts,
		requests,
		relayCalls,
		launches: () => launches,
		clientClosed: () => clientClosed,
		run: (provider: ConnectProvider, flags: ConnectFlags = {}) =>
			runConnect(provider, flags, deps),
	};
}

function expectNoSecret(h: Harness, ...secrets: string[]) {
	const printed = h.lines.join("\n");
	for (const secret of secrets) expect(printed).not.toContain(secret);
}

describe("channel-review connect datadog", () => {
	test("creates the token in the browser, stores it with meta and verifies it", async () => {
		const h = createHarness({
			page: {
				urls: [
					"https://app.datadoghq.com/account/login",
					"https://us5.datadoghq.com/personal-settings/access-tokens",
				],
				clipboard: DATADOG_TOKEN,
			},
		});
		await h.run("datadog");
		expect(h.fake.gotos[0]).toBe(
			"https://app.datadoghq.com/personal-settings/access-tokens",
		);
		expect(h.sets).toEqual([
			{
				name: "channel-review/datadog",
				value: DATADOG_TOKEN,
				meta: {
					provider: "datadog",
					site: "us5.datadoghq.com",
					scopes: ["error_tracking_read", "apm_read", "logs_read_data"],
					expiresAt: "2027-10-16T12:00:00.000Z",
					createdBy: "connect",
				},
			},
		]);
		expect(h.fake.grants).toEqual(["https://us5.datadoghq.com"]);
		for (const scope of ["error_tracking_read", "apm_read", "logs_read_data"]) {
			expect(
				h.fake.actions.some(
					(action) =>
						action.includes(`label[${scope}]`) && action.endsWith("click"),
				),
			).toBe(true);
		}
		expect(
			h.fake.actions.some((action) =>
				action.includes("fill(channel-review-daemon)"),
			),
		).toBe(true);
		expect(h.fake.cleared()).toBe(1);
		expect(h.fake.closed()).toBe(1);
		expect(h.requests[0]?.url).toBe(
			"https://api.us5.datadoghq.com/api/v2/error-tracking/issues/search",
		);
		expect(new Headers(h.requests[0]?.init.headers).get("Authorization")).toBe(
			`Bearer ${DATADOG_TOKEN}`,
		);
		expect(h.requests[0]?.init.redirect).toBe("error");
		expect(h.granted).toEqual(["channel-review"]);
		expect(h.lines).toEqual([
			"Sign in in the browser window. Waiting up to 10 minutes.",
			"stored channel-review/datadog",
			"created the channel-review credential grant",
			"verified (HTTP 200)",
		]);
		expect(h.clientClosed()).toBe(1);
		expectNoSecret(h, DATADOG_TOKEN);
	});

	test("revokes the old token with the same name only after the new token is stored", async () => {
		const h = createHarness({
			page: {
				urls: ["https://app.datadoghq.com/personal-settings/access-tokens"],
				clipboard: DATADOG_TOKEN,
				rows: ["channel-review-daemon created 2026-01-01"],
			},
			grants: [
				{
					prefix: "channel-review",
					createdAt: "2026-01-01T00:00:00Z",
					lastUsedAt: null,
				},
			],
		});
		await h.run("datadog", { site: "datadoghq.com" });
		const revoke = h.fake.actions.findIndex((action) =>
			action.includes("(/revoke/i)"),
		);
		const create = h.fake.actions.findIndex((action) =>
			action.includes("new (access )?token"),
		);
		const stored = h.fake.actions.indexOf("STORE");
		expect(create).toBeGreaterThan(-1);
		expect(stored).toBeGreaterThan(create);
		expect(revoke).toBeGreaterThan(stored);
		expect(
			h.fake.actions
				.filter((action) => action.includes("role=row"))
				.filter((action) => action.includes("(/revoke/i)"))
				.every((action) =>
					action.includes("[channel-review-daemon created 2026-01-01]"),
				),
		).toBe(true);
		expect(h.sets[0]?.meta?.site).toBe("datadoghq.com");
		expect(h.granted).toEqual([]);
	});

	test("does not revoke the old token when copying the new token fails", async () => {
		const h = createHarness({
			page: {
				urls: ["https://app.datadoghq.com/personal-settings/access-tokens"],
				failOn: /role=button\(\/copy\/i\)/,
				rows: ["channel-review-daemon created 2026-01-01"],
			},
			pasted: DATADOG_TOKEN,
		});
		await h.run("datadog");
		expect(h.fake.actions.some((a) => a.includes("(/revoke/i)"))).toBe(false);
		expect(h.sets).toHaveLength(1);
	});

	test("does not revoke the old token when storing the new token fails", async () => {
		const h = createHarness({
			page: {
				urls: ["https://app.datadoghq.com/personal-settings/access-tokens"],
				clipboard: DATADOG_TOKEN,
				rows: ["channel-review-daemon created 2026-01-01"],
			},
			pasted: DATADOG_TOKEN,
			failSet: true,
		});
		await h.run("datadog");
		expect(h.fake.actions.some((a) => a.includes("(/revoke/i)"))).toBe(false);
	});

	test("rejects a site that is not a Datadog site before any request", async () => {
		for (const site of [
			"datadoghq.example.net",
			"evil-datadoghq.com",
			"datadoghq.com.evil.net",
		]) {
			const h = createHarness({ pasted: DATADOG_TOKEN });
			const error = await h
				.run("datadog", { site, paste: true })
				.catch((caught: Error) => caught);
			expect((error as Error).message).toBe("That is not a Datadog site.");
			expect(h.requests).toEqual([]);
			expect(h.sets).toEqual([]);
		}
	});

	test("accepts the known Datadog sites", async () => {
		for (const site of [
			"datadoghq.com",
			"datadoghq.eu",
			"us3.datadoghq.com",
			"us5.datadoghq.com",
			"ap1.datadoghq.com",
			"ap2.datadoghq.com",
			"ddog-gov.com",
			"app.datadoghq.com",
		]) {
			const h = createHarness({ pasted: DATADOG_TOKEN });
			await h.run("datadog", { site, paste: true });
			expect(h.requests).toHaveLength(1);
		}
	});

	test("does not trust a sign-in host that only contains datadoghq", async () => {
		const h = createHarness({
			page: {
				urls: ["https://datadoghq.example.net/personal-settings/access-tokens"],
				clipboard: DATADOG_TOKEN,
			},
			pasted: DATADOG_TOKEN,
		});
		h.deps.sleep = async () => {
			throw new Error("stop waiting");
		};
		await h.run("datadog");
		expect(h.sets).toHaveLength(1);
		expect(h.fake.actions.some((a) => a.includes("fill("))).toBe(false);
	});

	test("rejects a copied value that is not a token, clears the clipboard and falls back to paste", async () => {
		const wrong = "not-a-token-value-1234567890";
		const h = createHarness({
			page: {
				urls: ["https://us5.datadoghq.com/personal-settings/access-tokens"],
				clipboard: wrong,
			},
			pasted: DATADOG_TOKEN,
		});
		await h.run("datadog", { site: "us5.datadoghq.com" });
		expect(h.fake.cleared()).toBe(1);
		expect(h.opened).toEqual([
			"https://us5.datadoghq.com/personal-settings/access-tokens",
		]);
		expect(h.sets[0]?.value).toBe(DATADOG_TOKEN);
		expect(
			h.lines.some((line) => line.includes("Falling back to paste mode")),
		).toBe(true);
		expectNoSecret(h, DATADOG_TOKEN, wrong);
	});

	test("paste mode opens the default browser and never launches Chrome", async () => {
		const h = createHarness({ pasted: `${DATADOG_TOKEN}\n`, status: 403 });
		await h.run("datadog", { paste: true });
		expect(h.launches()).toBe(0);
		expect(h.opened).toEqual([
			"https://app.datadoghq.com/personal-settings/access-tokens",
		]);
		expect(h.prompts).toEqual(["Datadog access token: "]);
		expect(h.sets[0]?.value).toBe(DATADOG_TOKEN);
		expect(h.lines.at(-1)).toBe("verification failed (HTTP 403)");
		expectNoSecret(h, DATADOG_TOKEN);
	});

	test("paste mode refuses an invalid token without echoing it", async () => {
		const wrong = "ddpat_short";
		const h = createHarness({ pasted: wrong });
		const error = await h
			.run("datadog", { paste: true })
			.catch((caught: Error) => caught);
		expect((error as Error).message).toBe(
			"That is not a Datadog access token.",
		);
		expect(h.sets).toEqual([]);
		expectNoSecret(h, wrong);
	});

	test("does not print browser exceptions that may contain a token", async () => {
		const h = createHarness({ pasted: DATADOG_TOKEN });
		h.deps.launchBrowser = async () => {
			throw new Error(`browser error: ${DATADOG_TOKEN}`);
		};
		await h.run("datadog");
		expect(h.sets[0]?.value).toBe(DATADOG_TOKEN);
		expectNoSecret(h, DATADOG_TOKEN);
	});

	test("paste fallback reads the token from a hidden TTY prompt", async () => {
		const tty = Object.assign(new EventEmitter(), {
			raw: [] as boolean[],
			setRawMode(mode: boolean) {
				tty.raw.push(mode);
			},
			setEncoding: () => undefined,
			resume: () => undefined,
			pause: () => undefined,
		});
		const echoed: string[] = [];
		const h = createHarness();
		h.deps.readSecret = (prompt) => {
			const pending = promptHidden(prompt, tty, {
				write: (text) => echoed.push(text),
			});
			tty.emit("data", `${DATADOG_TOKEN.slice(0, 10)}x\u007f`);
			tty.emit("data", `${DATADOG_TOKEN.slice(10)}\r`);
			return pending;
		};
		await h.run("datadog", { paste: true });
		expect(h.sets[0]?.value).toBe(DATADOG_TOKEN);
		expect(tty.raw).toEqual([true, false]);
		expect(echoed.join("")).toBe("Datadog access token: \n");
		expectNoSecret(h, DATADOG_TOKEN);
	});
});

describe("channel-review connect sentry", () => {
	test("reads the token from the page and the org from the URL host", async () => {
		const h = createHarness({
			page: {
				urls: [
					"https://example-org.sentry.io/settings/account/api/auth-tokens/",
				],
				domToken: SENTRY_TOKEN,
			},
		});
		await h.run("sentry");
		expect(h.fake.gotos[0]).toBe(
			"https://sentry.io/settings/account/api/auth-tokens/",
		);
		expect(h.sets).toEqual([
			{
				name: "channel-review/sentry",
				value: SENTRY_TOKEN,
				meta: {
					provider: "sentry",
					site: "https://sentry.io",
					org: "example-org",
					scopes: ["event:read", "project:read", "org:read"],
					createdBy: "connect",
				},
			},
		]);
		expect(h.requests[0]?.url).toBe(
			"https://sentry.io/api/0/organizations/example-org/",
		);
		expect(h.lines.at(-1)).toBe("verified (HTTP 200)");
		expectNoSecret(h, SENTRY_TOKEN);
	});

	test("falls back to paste when a selector fails", async () => {
		const h = createHarness({
			page: {
				urls: ["https://sentry.example.test/settings/account/api/auth-tokens/"],
				failOn: /combobox/,
			},
			pasted: SENTRY_TOKEN,
		});
		await h.run("sentry", {
			site: "https://sentry.example.test",
			org: "example-org",
		});
		expect(h.opened).toEqual([
			"https://sentry.example.test/settings/account/api/auth-tokens/",
		]);
		expect(h.sets[0]?.meta).toMatchObject({
			site: "https://sentry.example.test",
			org: "example-org",
		});
		expect(
			h.lines.find((line) => line.startsWith("Browser automation failed")),
		).not.toContain("call log");
		expectNoSecret(h, SENTRY_TOKEN);
	});

	test("asks for --org when paste mode cannot find the organization", async () => {
		const h = createHarness({ pasted: SENTRY_TOKEN });
		await expect(h.run("sentry", { paste: true })).rejects.toThrow(
			"--org <slug>",
		);
		expect(h.prompts).toEqual([]);
	});
});

describe("channel-review connect relay", () => {
	test("fetches the secret once through AWS and prints only stored", async () => {
		const h = createHarness({
			grants: [
				{
					prefix: "channel-review",
					createdAt: "2026-01-01T00:00:00Z",
					lastUsedAt: null,
				},
			],
		});
		await h.run("relay", { env: "prod" });
		expect(h.relayCalls).toEqual([
			{
				profile: "example-dev",
				region: "us-east-1",
				id: "relay/chat",
				key: "KEY",
			},
		]);
		expect(h.sets).toEqual([
			{
				name: "channel-review/relay/prod",
				value: RELAY_SECRET,
				meta: { provider: "relay", createdBy: "connect" },
			},
		]);
		expect(h.lines).toEqual(["stored channel-review/relay/prod"]);
		expect(h.launches()).toBe(0);
	});
});
