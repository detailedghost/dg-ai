import { afterEach, describe, expect, test } from "bun:test";
import {
	type AccountInfo,
	type AuthenticationResult,
	TokenCacheContext,
} from "@azure/msal-node";
import {
	createEncryptedCachePlugin,
	EnvironmentMicrosoftTokenProvider,
	MAIL_SCOPE_PATTERN,
	type MicrosoftAuthSettings,
	StaticMicrosoftTokenProvider,
} from "@dg/common/msal";

const CHAT_SCOPE_PATTERN =
	/^(https:\/\/graph\.microsoft\.com\/)?(Chat\.Read|openid|profile|offline_access)$/;
const GRAPH_MAIL_READ = "https://graph.microsoft.com/Mail.Read";
const ENV_NAME = "DG_MSAL_TEST_ACCESS_TOKEN";
const NO_ENV = "DG_MSAL_TEST_NO_ACCESS";

const touchedEnv: string[] = [];
afterEach(() => {
	for (const name of touchedEnv.splice(0)) {
		delete process.env[name];
	}
});

function setEnv(name: string, value: string): void {
	touchedEnv.push(name);
	process.env[name] = value;
}

function settings(
	overrides: Partial<MicrosoftAuthSettings> = {},
): MicrosoftAuthSettings {
	return {
		clientId: "client",
		redirectUri: "http://localhost:0",
		tenantId: "organizations",
		authority: "https://login.microsoftonline.com",
		authMode: "device-code",
		accessTokenEnv: NO_ENV,
		scopePattern: MAIL_SCOPE_PATTERN,
		...overrides,
	};
}

function authResult(
	token: string,
	username = "user@contoso.com",
): AuthenticationResult {
	return {
		accessToken: token,
		account: { username } as AccountInfo,
		expiresOn: new Date("2030-01-01T00:00:00.000Z"),
	} as AuthenticationResult;
}

function publicApp(
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		getAllAccounts: async () => [],
		acquireTokenSilent: async () => {
			throw new Error("no account");
		},
		acquireTokenInteractive: async () => authResult("browser-token"),
		acquireTokenByDeviceCode: async () => authResult("device-token"),
		...overrides,
	};
}

function provider(
	overrides: Partial<MicrosoftAuthSettings>,
	services: Record<string, unknown> = {},
): EnvironmentMicrosoftTokenProvider {
	return new EnvironmentMicrosoftTokenProvider(settings(overrides), {
		cacheBinding: "binding",
		...services,
	} as never);
}

function seededCache(binding: string, scope: string): string {
	const home = "uid.utid";
	const env = "login.microsoftonline.com";
	const realm = "organizations";
	const clientId = "client";
	const toBase64Url = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const jwt = `${toBase64Url({ alg: "none" })}.${toBase64Url({
		preferred_username: "user@contoso.com",
		tid: realm,
		oid: "uid",
		sub: "sub",
		aud: clientId,
		iss: `https://${env}/${realm}/v2.0`,
		exp: 9999999999,
		iat: 1,
	})}.sig`;
	const now = Math.floor(Date.now() / 1000);
	const cache = {
		Account: {
			[`${home}-${env}-${realm}`]: {
				home_account_id: home,
				environment: env,
				realm,
				local_account_id: "uid",
				username: "user@contoso.com",
				authority_type: "MSSTS",
				name: "User",
			},
		},
		IdToken: {
			[`${home}-${env}-idtoken-${clientId}-${realm}-`]: {
				home_account_id: home,
				environment: env,
				credential_type: "IdToken",
				client_id: clientId,
				secret: jwt,
				realm,
			},
		},
		AccessToken: {
			[`${home}-${env}-accesstoken-${clientId}-${realm}-${scope}`]: {
				home_account_id: home,
				environment: env,
				credential_type: "AccessToken",
				client_id: clientId,
				secret: "seeded-token",
				realm,
				target: scope,
				cached_at: String(now),
				expires_on: String(now + 3600),
				extended_expires_on: String(now + 7200),
				token_type: "Bearer",
			},
		},
		RefreshToken: {},
		AppMetadata: {},
	};
	return JSON.stringify({ binding, cache: JSON.stringify(cache) });
}

describe("EnvironmentMicrosoftTokenProvider env token", () => {
	test("returns the token from the configured accessTokenEnv without touching the app", async () => {
		setEnv(ENV_NAME, "env-token");
		const token = await provider(
			{ accessTokenEnv: ENV_NAME },
			{
				app: publicApp({
					acquireTokenByDeviceCode: async () => {
						throw new Error("app must not run");
					},
				}),
			},
		).getToken(["Mail.Read"]);
		expect(token).toEqual({
			accessToken: "env-token",
			accountHint: "env-token",
		});
	});

	test("falls back to MICROSOFT_ACCESS_TOKEN when accessTokenEnv is unset", async () => {
		const previous = process.env.MICROSOFT_ACCESS_TOKEN;
		process.env.MICROSOFT_ACCESS_TOKEN = "default-env-token";
		try {
			const token = await provider({ accessTokenEnv: undefined }).getToken([
				"Mail.Read",
			]);
			expect(token.accessToken).toBe("default-env-token");
		} finally {
			if (previous === undefined) {
				delete process.env.MICROSOFT_ACCESS_TOKEN;
			} else {
				process.env.MICROSOFT_ACCESS_TOKEN = previous;
			}
		}
	});
});

describe("EnvironmentMicrosoftTokenProvider validation", () => {
	test("rejects a missing client id with the MICROSOFT_CLIENT_ID hint", async () => {
		await expect(
			provider({ clientId: undefined }, { app: publicApp() }).getToken([
				"Mail.Read",
			]),
		).rejects.toThrow("MICROSOFT_CLIENT_ID");
	});

	test("rejects an untrusted authority", async () => {
		await expect(
			provider(
				{ authority: "https://login.microsoftonline.com.attacker.example" },
				{ app: publicApp() },
			).getToken(["Mail.Read"]),
		).rejects.toThrow("authority");
	});

	test("rejects a scope outside the default mail pattern with a Graph message", async () => {
		await expect(
			provider({}, { app: publicApp() }).getToken([
				"https://attacker.example/Mail.Read",
			]),
		).rejects.toThrow("Graph");
	});

	test("rejects an empty scope list with a Graph message", async () => {
		await expect(
			provider({}, { app: publicApp() }).getToken([]),
		).rejects.toThrow("Graph");
	});

	test("accepts Chat.Read under a caller-supplied scopePattern", async () => {
		const token = await provider(
			{ scopePattern: CHAT_SCOPE_PATTERN },
			{ app: publicApp() },
		).getToken(["Chat.Read"]);
		expect(token.accessToken).toBe("device-token");
	});

	test("rejects Chat.Read under MAIL_SCOPE_PATTERN", async () => {
		await expect(
			provider(
				{ scopePattern: MAIL_SCOPE_PATTERN },
				{ app: publicApp() },
			).getToken(["Chat.Read"]),
		).rejects.toThrow("Graph");
	});

	test("rejects a mail scope under the Chat.Read pattern", async () => {
		await expect(
			provider(
				{ scopePattern: CHAT_SCOPE_PATTERN },
				{ app: publicApp() },
			).getToken(["Mail.Read"]),
		).rejects.toThrow("Graph");
	});
});

describe("MAIL_SCOPE_PATTERN", () => {
	test("accepts mail and profile scopes in short and Graph URL form", () => {
		for (const scope of [
			"Mail.Read",
			"Mail.ReadWrite",
			"MailboxSettings.Read",
			"User.Read",
			"openid",
			"profile",
			"offline_access",
			GRAPH_MAIL_READ,
		]) {
			expect(MAIL_SCOPE_PATTERN.test(scope)).toBe(true);
		}
	});

	test("rejects foreign hosts and unrelated Graph permissions", () => {
		for (const scope of [
			"https://attacker.example/Mail.Read",
			"Chat.Read",
			"Files.ReadWrite",
			"",
		]) {
			expect(MAIL_SCOPE_PATTERN.test(scope)).toBe(false);
		}
	});
});

describe("EnvironmentMicrosoftTokenProvider cache behavior", () => {
	test("uses a cached account before opening a browser", async () => {
		let browserOpened = false;
		const token = await provider(
			{ authMode: "browser", loginHint: "user@contoso.com" },
			{
				app: publicApp({
					getAllAccounts: async () => [
						{ username: "user@contoso.com" } as AccountInfo,
					],
					acquireTokenSilent: async () => authResult("cached-token"),
					acquireTokenInteractive: async () => {
						browserOpened = true;
						return authResult("browser-token");
					},
				}),
			},
		).getToken(["Mail.Read"]);
		expect(token).toMatchObject({
			accessToken: "cached-token",
			accountHint: "user@contoso.com",
		});
		expect(browserOpened).toBe(false);
	});

	test("works with no cache store in device-code mode using an injected app", async () => {
		const token = await provider(
			{ authMode: "device-code" },
			{
				app: publicApp(),
			},
		).getToken(["Mail.Read"]);
		expect(token.accessToken).toBe("device-token");
	});

	test("does not throw about storage when no cache is given and no app is injected", async () => {
		const outcome = await provider({ authMode: "silent" })
			.getToken(["Mail.Read"])
			.then(
				() => "resolved",
				(error: Error) => error.message,
			);
		expect(outcome).toContain("no cached Microsoft account");
		expect(outcome).not.toContain("encrypted profile storage");
	});

	test("reads a matching-binding account from an injected cache store", async () => {
		const token = await provider(
			{ authMode: "silent", loginHint: "user@contoso.com" },
			{
				cacheBinding: "binding-a",
				cache: {
					get: async () => seededCache("binding-a", GRAPH_MAIL_READ),
					set: async () => {},
				},
			},
		).getToken([GRAPH_MAIL_READ]);
		expect(token.accessToken).toBe("seeded-token");
	});

	test("ignores a cache bound to another binding", async () => {
		await expect(
			provider(
				{ authMode: "silent", loginHint: "user@contoso.com" },
				{
					cacheBinding: "binding-a",
					cache: {
						get: async () => seededCache("binding-b", GRAPH_MAIL_READ),
						set: async () => {},
					},
				},
			).getToken([GRAPH_MAIL_READ]),
		).rejects.toThrow("no cached Microsoft account");
	});

	test("accepts the cache as a factory and reads through it", async () => {
		let calls = 0;
		const token = await provider(
			{ authMode: "silent", loginHint: "user@contoso.com" },
			{
				cacheBinding: "binding-a",
				cache: () => {
					calls += 1;
					return {
						get: async () => seededCache("binding-a", GRAPH_MAIL_READ),
						set: async () => {},
					};
				},
			},
		).getToken([GRAPH_MAIL_READ]);
		expect(token.accessToken).toBe("seeded-token");
		expect(calls).toBe(1);
	});
});

describe("EnvironmentMicrosoftTokenProvider lazy cache factory", () => {
	function failingFactory(calls: { count: number }) {
		return () => {
			calls.count += 1;
			throw new Error("factory storage failure");
		};
	}

	test("is not called when the env token shortcut applies", async () => {
		setEnv(ENV_NAME, "env-token");
		const calls = { count: 0 };
		const token = await provider(
			{ accessTokenEnv: ENV_NAME },
			{ cache: failingFactory(calls) },
		).getToken(["Mail.Read"]);
		expect(token.accessToken).toBe("env-token");
		expect(calls.count).toBe(0);
	});

	test("is not called when the client id is missing", async () => {
		const calls = { count: 0 };
		await expect(
			provider(
				{ clientId: undefined },
				{ cache: failingFactory(calls) },
			).getToken(["Mail.Read"]),
		).rejects.toThrow("MICROSOFT_CLIENT_ID");
		expect(calls.count).toBe(0);
	});

	test("is not called when the authority is invalid", async () => {
		const calls = { count: 0 };
		await expect(
			provider(
				{ authority: "https://login.microsoftonline.com.attacker.example" },
				{ cache: failingFactory(calls) },
			).getToken(["Mail.Read"]),
		).rejects.toThrow("authority");
		expect(calls.count).toBe(0);
	});

	test("is not called when a scope fails validation", async () => {
		const calls = { count: 0 };
		await expect(
			provider({}, { cache: failingFactory(calls) }).getToken(["Chat.Read"]),
		).rejects.toThrow("Graph");
		expect(calls.count).toBe(0);
	});

	test("is not called when an app is injected", async () => {
		const calls = { count: 0 };
		const token = await provider(
			{},
			{ app: publicApp(), cache: failingFactory(calls) },
		).getToken(["Mail.Read"]);
		expect(token.accessToken).toBe("device-token");
		expect(calls.count).toBe(0);
	});

	test("runs after validation and surfaces its error as a getToken rejection", async () => {
		const calls = { count: 0 };
		const pending = provider({}, { cache: failingFactory(calls) }).getToken([
			"Mail.Read",
		]);
		expect(pending).toBeInstanceOf(Promise);
		await expect(pending).rejects.toThrow("factory storage failure");
		expect(calls.count).toBe(1);
	});
});

describe("EnvironmentMicrosoftTokenProvider auth modes", () => {
	test("silent mode with no cached account fails with the Outlook wording", async () => {
		await expect(
			provider({ authMode: "silent" }, { app: publicApp() }).getToken([
				"Mail.Read",
			]),
		).rejects.toThrow("no cached Microsoft account");
	});

	test("does not select another cached account when the login hint differs", async () => {
		let silentCalls = 0;
		await expect(
			provider(
				{ authMode: "silent", loginHint: "wanted@example.com" },
				{
					app: publicApp({
						getAllAccounts: async () => [
							{ username: "other@example.com" } as AccountInfo,
						],
						acquireTokenSilent: async () => {
							silentCalls += 1;
							return authResult("wrong-account");
						},
					}),
				},
			).getToken(["Mail.Read"]),
		).rejects.toThrow("no cached Microsoft account");
		expect(silentCalls).toBe(0);
	});

	test("device-code mode requires a public client app", async () => {
		await expect(
			provider(
				{ authMode: "device-code" },
				{
					app: {
						getTokenCache: () => ({ getAllAccounts: async () => [] }),
						acquireTokenSilent: async () => {
							throw new Error("no account");
						},
						getAuthCodeUrl: async () => "",
						acquireTokenByCode: async () => authResult("code-token"),
					},
				},
			).getToken(["Mail.Read"]),
		).rejects.toThrow("public-client");
	});

	test("device-code logs only trusted Microsoft verification URLs", async () => {
		const logs: string[] = [];
		const run = async (verificationUri: string) =>
			provider(
				{ authMode: "device-code" },
				{
					deviceCodeLogger: (message: string) => logs.push(message),
					app: publicApp({
						acquireTokenByDeviceCode: async (input: {
							deviceCodeCallback: (response: {
								verificationUri?: string;
								userCode?: string;
							}) => void;
						}) => {
							input.deviceCodeCallback({ verificationUri, userCode: "ABC123" });
							return authResult("device-token");
						},
					}),
				},
			).getToken(["Mail.Read"]);
		await run("https://www.microsoft.com/link");
		await run("https://attacker.example/link");
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("https://www.microsoft.com/link");
		expect(logs[0]).toContain("ABC123");
	});

	test("browser mode refuses to open a non-Microsoft login URL", async () => {
		const opened: string[] = [];
		await expect(
			provider(
				{ authMode: "browser" },
				{
					openBrowser: async (url: string) => {
						opened.push(url);
					},
					app: publicApp({
						acquireTokenInteractive: async (input: {
							openBrowser: (url: string) => Promise<void>;
						}) => {
							await input.openBrowser("https://attacker.example/login");
							return authResult("browser-token");
						},
					}),
				},
			).getToken(["Mail.Read"]),
		).rejects.toThrow("Microsoft authentication failed");
		expect(opened).toEqual([]);
	});

	test("sanitizes raw Microsoft authentication errors", async () => {
		await expect(
			provider(
				{ authMode: "browser" },
				{
					app: publicApp({
						acquireTokenInteractive: async () => {
							throw new Error("raw-provider-secret");
						},
					}),
				},
			).getToken(["Mail.Read"]),
		).rejects.toThrow("Microsoft authentication failed");
	});

	test("shares one acquisition across concurrent calls with the same scopes", async () => {
		let calls = 0;
		const subject = provider(
			{ authMode: "device-code" },
			{
				app: publicApp({
					acquireTokenByDeviceCode: async () => {
						calls += 1;
						await Promise.resolve();
						return authResult("device-token");
					},
				}),
			},
		);
		const [first, second] = await Promise.all([
			subject.getToken(["Mail.Read", "User.Read"]),
			subject.getToken(["User.Read", "Mail.Read", "Mail.Read"]),
		]);
		expect(first.accessToken).toBe("device-token");
		expect(second.accessToken).toBe("device-token");
		expect(calls).toBe(1);
	});
});

describe("StaticMicrosoftTokenProvider", () => {
	test("returns the fixed token", async () => {
		expect(await new StaticMicrosoftTokenProvider("fixed").getToken()).toEqual({
			accessToken: "fixed",
			accountHint: "test-token",
		});
	});
});

describe("createEncryptedCachePlugin", () => {
	test("round-trips changed cache data through the injected store bound to the binding", async () => {
		let value: string | null = null;
		let restored = "";
		const cache = {
			serialize: () => "private-msal-cache",
			deserialize: (data: string) => {
				restored = data;
			},
		};
		const plugin = createEncryptedCachePlugin(
			{
				get: async () => value,
				set: async (next: string) => {
					value = next;
				},
			},
			"profile-binding",
		);
		await plugin.afterCacheAccess(new TokenCacheContext(cache, false));
		expect(value).toBeNull();
		await plugin.afterCacheAccess(new TokenCacheContext(cache, true));
		await plugin.beforeCacheAccess(new TokenCacheContext(cache, false));
		expect(restored).toBe(cache.serialize());
		expect(JSON.parse(value!).binding).toBe("profile-binding");
	});

	test("ignores an encrypted cache that belongs to another binding", async () => {
		let restores = 0;
		const plugin = createEncryptedCachePlugin(
			{
				get: async () =>
					JSON.stringify({ binding: "other-client", cache: "secret" }),
				set: async () => {},
			},
			"configured-client",
		);
		await plugin.beforeCacheAccess(
			new TokenCacheContext(
				{
					serialize: () => "",
					deserialize: () => {
						restores += 1;
					},
				},
				false,
			),
		);
		expect(restores).toBe(0);
	});

	test("ignores a stored value that is not JSON", async () => {
		let restores = 0;
		const plugin = createEncryptedCachePlugin(
			{ get: async () => "not-json", set: async () => {} },
			"binding",
		);
		await plugin.beforeCacheAccess(
			new TokenCacheContext(
				{
					serialize: () => "",
					deserialize: () => {
						restores += 1;
					},
				},
				false,
			),
		);
		expect(restores).toBe(0);
	});

	test("reports an invalid cache when deserialization of a matching binding fails", async () => {
		const plugin = createEncryptedCachePlugin(
			{
				get: async () => JSON.stringify({ binding: "b", cache: "corrupt" }),
				set: async () => {},
			},
			"b",
		);
		await expect(
			plugin.beforeCacheAccess(
				new TokenCacheContext(
					{
						serialize: () => "",
						deserialize: () => {
							throw new Error("bad");
						},
					},
					false,
				),
			),
		).rejects.toThrow("encrypted authentication cache is invalid");
	});
});
