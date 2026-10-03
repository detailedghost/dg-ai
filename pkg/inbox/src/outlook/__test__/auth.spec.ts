import { describe, expect, test } from "bun:test";
import type { AccountInfo, AuthenticationResult } from "@azure/msal-node";
import { defaultConfig } from "../../config/defaults";
import { EnvironmentMicrosoftTokenProvider } from "../auth";

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

describe("EnvironmentMicrosoftTokenProvider", () => {
	test("uses cached MSAL accounts before opening a browser", async () => {
		let browserOpened = false;
		const provider = new EnvironmentMicrosoftTokenProvider(
			{
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					clientId: "client-id",
					loginHint: "user@contoso.com",
				},
			},
			{
				app: {
					getAllAccounts: async () => [
						{ username: "user@contoso.com" } as AccountInfo,
					],
					acquireTokenSilent: async () => authResult("cached-token"),
					acquireTokenInteractive: async () => {
						browserOpened = true;
						return authResult("browser-token");
					},
					acquireTokenByDeviceCode: async () => authResult("device-token"),
				},
			},
		);

		const token = await provider.getToken(["Mail.Read"]);
		expect(token).toMatchObject({
			accessToken: "cached-token",
			accountHint: "user@contoso.com",
		});
		expect(browserOpened).toBe(false);
	});

	test("opens browser auth when no cached account exists", async () => {
		const openedUrls: string[] = [];
		const provider = new EnvironmentMicrosoftTokenProvider(
			{
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					clientId: "client-id",
					authMode: "browser",
					loginHint: "user@contoso.com",
				},
			},
			{
				openBrowser: async (url) => {
					openedUrls.push(url);
				},
				app: {
					getAllAccounts: async () => [],
					acquireTokenSilent: async () => {
						throw new Error("no cache");
					},
					acquireTokenInteractive: async (input) => {
						expect(input.loginHint).toBe("user@contoso.com");
						await input.openBrowser("https://login.microsoftonline.com");
						return authResult("browser-token");
					},
					acquireTokenByDeviceCode: async () => authResult("device-token"),
				},
			},
		);

		const token = await provider.getToken(["Mail.Read", "Mail.Read"]);
		expect(token).toMatchObject({ accessToken: "browser-token" });
		expect(openedUrls).toEqual(["https://login.microsoftonline.com"]);
	});

	test("uses confidential browser auth when a client secret is configured", async () => {
		const openedUrls: string[] = [];
		const provider = new EnvironmentMicrosoftTokenProvider(
			{
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					clientId: "client-id",
					clientSecret: "configured",
					authMode: "browser",
					loginHint: "user@contoso.com",
					redirectUri: "http://127.0.0.1:0/oauth2/callback",
				},
			},
			{
				openBrowser: async (url) => {
					openedUrls.push(url);
				},
				browserCodeAuth: async (app, input) => {
					expect(input.loginHint).toBe("user@contoso.com");
					await input.openBrowser(
						"https://login.microsoftonline.com/authorize",
					);
					const url = await app.getAuthCodeUrl(input);
					expect(url).toBe("https://login.microsoftonline.com/authorize");
					return app.acquireTokenByCode({
						scopes: input.scopes,
						redirectUri: input.redirectUri,
						code: "auth-code",
						state: "state",
					});
				},
				app: {
					getTokenCache: () => ({
						getAllAccounts: async () => [],
					}),
					acquireTokenSilent: async () => {
						throw new Error("no cache");
					},
					getAuthCodeUrl: async (input) => {
						expect(input.redirectUri).toBe(
							"http://127.0.0.1:0/oauth2/callback",
						);
						return "https://login.microsoftonline.com/authorize";
					},
					acquireTokenByCode: async (input) => {
						expect(input.code).toBe("auth-code");
						expect(input.state).toBe("state");
						expect(input.redirectUri).toBe(
							"http://127.0.0.1:0/oauth2/callback",
						);
						return authResult("secret-token");
					},
				},
			},
		);

		const token = await provider.getToken(["Mail.Read"]);
		expect(token).toMatchObject({ accessToken: "secret-token" });
		expect(openedUrls).toEqual(["https://login.microsoftonline.com/authorize"]);
	});

	test("rejects device-code auth when a confidential client is configured", async () => {
		const provider = new EnvironmentMicrosoftTokenProvider(
			{
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					clientId: "client-id",
					clientSecret: "configured",
					authMode: "device-code",
				},
			},
			{
				app: {
					getTokenCache: () => ({
						getAllAccounts: async () => [],
					}),
					acquireTokenSilent: async () => {
						throw new Error("no cache");
					},
					getAuthCodeUrl: async () => "http://127.0.0.1",
					acquireTokenByCode: async () => authResult("secret-token"),
				},
			},
		);

		await expect(provider.getToken(["Mail.Read"])).rejects.toThrow(
			"Outlook device-code auth requires a public-client app",
		);
	});

	test("uses device-code auth only when configured", async () => {
		const messages: string[] = [];
		const provider = new EnvironmentMicrosoftTokenProvider(
			{
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					clientId: "client-id",
					authMode: "device-code",
				},
			},
			{
				deviceCodeLogger: (message) => messages.push(message),
				app: {
					getAllAccounts: async () => [],
					acquireTokenSilent: async () => {
						throw new Error("no cache");
					},
					acquireTokenInteractive: async () => authResult("browser-token"),
					acquireTokenByDeviceCode: async (input) => {
						input.deviceCodeCallback({
							verificationUri: "https://microsoft.com/devicelogin",
							userCode: "ABCD",
						});
						return authResult("device-token");
					},
				},
			},
		);

		const token = await provider.getToken(["Mail.Read"]);
		expect(token).toMatchObject({ accessToken: "device-token" });
		expect(messages).toEqual([
			"Open https://microsoft.com/devicelogin and enter code ABCD",
		]);
	});

	test("silent auth fails closed without cached accounts", async () => {
		const provider = new EnvironmentMicrosoftTokenProvider(
			{
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					clientId: "client-id",
					authMode: "silent",
				},
			},
			{
				app: {
					getAllAccounts: async () => [],
					acquireTokenSilent: async () => {
						throw new Error("no cache");
					},
					acquireTokenInteractive: async () => authResult("browser-token"),
					acquireTokenByDeviceCode: async () => authResult("device-token"),
				},
			},
		);

		await expect(provider.getToken(["Mail.Read"])).rejects.toThrow(
			"Outlook silent auth found no cached Microsoft account",
		);
	});
});

describe("EnvironmentMicrosoftTokenProvider concurrent acquisitions", () => {
	function providerForInteractiveLogin(
		login: () => Promise<AuthenticationResult>,
	) {
		return new EnvironmentMicrosoftTokenProvider(
			{
				...defaultConfig,
				outlook: {
					...defaultConfig.outlook,
					clientId: "synthetic-client",
					authMode: "browser",
				},
			},
			{
				app: {
					getAllAccounts: async () => [],
					acquireTokenSilent: async () => {
						throw new Error("scope consent required");
					},
					acquireTokenInteractive: login,
					acquireTokenByDeviceCode: async () => null,
				},
			},
		);
	}
	test("shares overlapping acquisitions with equivalent scope sets", async () => {
		let interactiveCalls = 0;
		const provider = providerForInteractiveLogin(async () => {
			interactiveCalls++;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return authResult("synthetic-token");
		});
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				provider.getToken(
					index % 2
						? ["User.Read", "Mail.ReadWrite"]
						: ["Mail.ReadWrite", "User.Read", "Mail.ReadWrite"],
				),
			),
		);
		expect(results.map((result) => result.accessToken)).toEqual(
			Array(20).fill("synthetic-token"),
		);
		expect(interactiveCalls).toBe(1);
	});

	test("clears a failed shared acquisition so the next attempt can sign in", async () => {
		let interactiveCalls = 0;
		const provider = providerForInteractiveLogin(async () => {
			const attempt = ++interactiveCalls;
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (attempt === 1) throw new Error("Login canceled");
			return authResult("retry-token");
		});
		const failures = await Promise.allSettled(
			Array.from({ length: 3 }, () => provider.getToken(["Mail.ReadWrite"])),
		);
		expect(failures.map((result) => result.status)).toEqual(
			Array(3).fill("rejected"),
		);
		expect(interactiveCalls).toBe(1);
		expect((await provider.getToken(["Mail.ReadWrite"])).accessToken).toBe(
			"retry-token",
		);
		expect(interactiveCalls).toBe(2);
	});
});
