import { describe, expect, test } from "bun:test";
import {
	TokenCacheContext,
	type AccountInfo,
	type AuthenticationResult,
} from "@azure/msal-node";
import { defaultConfig } from "../../config/defaults";
import {
	EnvironmentMicrosoftTokenProvider,
	createEncryptedCachePlugin,
} from "../auth";

function app() {
	return {
		getAllAccounts: async () => [],
		acquireTokenSilent: async () => {
			throw new Error("no account");
		},
		acquireTokenInteractive: async () =>
			({ accessToken: "token" }) as AuthenticationResult,
		acquireTokenByDeviceCode: async () =>
			({ accessToken: "token" }) as AuthenticationResult,
	};
}
function config() {
	return {
		...defaultConfig,
		outlook: {
			...defaultConfig.outlook,
			clientId: "client",
			accessTokenEnv: "DG_OAUTH_TEST_NO_ACCESS",
		},
	};
}

describe("Microsoft encrypted OAuth cache", () => {
	test("writes changed cache data to the injected encrypted store and restores matching profiles", async () => {
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
				set: async (next) => {
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
	test("ignores encrypted caches belonging to another profile configuration", async () => {
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
	test("rejects untrusted authority and non-Graph scopes before token acquisition", async () => {
		const settings = config();
		settings.outlook.authority =
			"https://login.microsoftonline.com.attacker.example";
		await expect(
			new EnvironmentMicrosoftTokenProvider(settings, { app: app() }).getToken([
				"Mail.Read",
			]),
		).rejects.toThrow("authority");
		await expect(
			new EnvironmentMicrosoftTokenProvider(config(), { app: app() }).getToken([
				"https://attacker.example/Mail.Read",
			]),
		).rejects.toThrow("Graph");
	});
	test("requires encrypted storage even when legacy plaintext-cache flags are enabled", async () => {
		const settings = config();
		settings.outlook.allowPlaintextTokenCache = true;
		await expect(
			new EnvironmentMicrosoftTokenProvider(settings).getToken(["Mail.Read"]),
		).rejects.toThrow("encrypted profile storage");
	});
	test("does not silently select another cached account when the login hint is missing", async () => {
		let silentCalls = 0;
		const settings = config();
		settings.outlook.authMode = "silent";
		settings.outlook.loginHint = "wanted@example.com";
		const client = {
			...app(),
			getAllAccounts: async () => [
				{ username: "other@example.com" } as AccountInfo,
			],
			acquireTokenSilent: async () => {
				silentCalls += 1;
				return { accessToken: "wrong-account" } as AuthenticationResult;
			},
		};
		await expect(
			new EnvironmentMicrosoftTokenProvider(settings, { app: client }).getToken(
				["Mail.Read"],
			),
		).rejects.toThrow("no cached Microsoft account");
		expect(silentCalls).toBe(0);
	});
	test("sanitizes raw Microsoft authentication errors", async () => {
		const client = {
			...app(),
			acquireTokenInteractive: async () => {
				throw new Error("raw-provider-secret");
			},
		};
		await expect(
			new EnvironmentMicrosoftTokenProvider(config(), { app: client }).getToken(
				["Mail.Read"],
			),
		).rejects.toThrow("Microsoft authentication failed");
	});
	test("exchanges a verified browser callback using PKCE and the registered redirect", async () => {
		let verifier = "";
		let challenge = "";
		let redirect = "";
		const client = {
			getTokenCache: () => ({ getAllAccounts: async () => [] }),
			acquireTokenSilent: async () => {
				throw new Error("no account");
			},
			getAuthCodeUrl: async (input: {
				redirectUri: string;
				state?: string;
				codeChallenge?: string;
			}) => {
				redirect = input.redirectUri;
				challenge = input.codeChallenge!;
				return `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?${new URLSearchParams({ redirect_uri: input.redirectUri, state: input.state! })}`;
			},
			acquireTokenByCode: async (input: {
				code: string;
				redirectUri: string;
				codeVerifier?: string;
			}) => {
				expect(input.code).toBe("verified-code");
				expect(input.redirectUri).toBe(redirect);
				verifier = input.codeVerifier!;
				return { accessToken: "browser-token" } as AuthenticationResult;
			},
		};
		const settings = config();
		settings.outlook.redirectUri = "http://127.0.0.1:0/oauth";
		const provider = new EnvironmentMicrosoftTokenProvider(settings, {
			app: client,
			openBrowser: async (value) => {
				const url = new URL(value);
				const callback = new URL(url.searchParams.get("redirect_uri")!);
				callback.search = new URLSearchParams({
					code: "verified-code",
					state: url.searchParams.get("state")!,
				}).toString();
				await fetch(callback);
			},
		});
		expect((await provider.getToken(["Mail.Read"])).accessToken).toBe(
			"browser-token",
		);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(verifier),
		);
		expect(Buffer.from(digest).toString("base64url")).toBe(challenge);
		await expect(fetch(redirect)).rejects.toThrow();
	});
	test("does not exchange a code when Microsoft browser state is invalid", async () => {
		let exchanged = false;
		const client = {
			getTokenCache: () => ({ getAllAccounts: async () => [] }),
			acquireTokenSilent: async () => {
				throw new Error("no account");
			},
			getAuthCodeUrl: async (input: { redirectUri: string }) =>
				`https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?${new URLSearchParams({ redirect_uri: input.redirectUri })}`,
			acquireTokenByCode: async () => {
				exchanged = true;
				return { accessToken: "wrong-token" } as AuthenticationResult;
			},
		};
		const settings = config();
		settings.outlook.redirectUri = "http://127.0.0.1:0/oauth";
		const provider = new EnvironmentMicrosoftTokenProvider(settings, {
			app: client,
			openBrowser: async (value) => {
				const callback = new URL(
					new URL(value).searchParams.get("redirect_uri")!,
				);
				callback.search = "?state=wrong-state&code=secret";
				await fetch(callback);
			},
		});
		await expect(provider.getToken(["Mail.Read"])).rejects.toThrow(
			"Microsoft authentication failed",
		);
		expect(exchanged).toBe(false);
	});
});
