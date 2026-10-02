import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../../config/defaults";
import { EnvironmentGoogleTokenProvider } from "../auth";
import {
	listenForOAuthCode,
	validateLoopbackRedirect,
} from "../oauth-loopback";

const scope = "https://www.googleapis.com/auth/gmail.readonly";
const originalAccess = process.env.GOOGLE_ACCESS_TOKEN;
const originalRefresh = process.env.GOOGLE_REFRESH_TOKEN;
afterEach(() => {
	if (originalAccess === undefined) {
		delete process.env.GOOGLE_ACCESS_TOKEN;
	} else {
		process.env.GOOGLE_ACCESS_TOKEN = originalAccess;
	}
	if (originalRefresh === undefined) {
		delete process.env.GOOGLE_REFRESH_TOKEN;
	} else {
		process.env.GOOGLE_REFRESH_TOKEN = originalRefresh;
	}
});
function config(clientId = "desktop-client") {
	return {
		...defaultConfig,
		gmail: {
			...defaultConfig.gmail,
			clientId,
			redirectUri: "http://127.0.0.1:0/oauth/callback",
			accessTokenEnv: "DG_OAUTH_TEST_NO_ACCESS",
			refreshTokenEnv: "DG_OAUTH_TEST_NO_REFRESH",
		},
	};
}
function memoryCache() {
	let value: string | null = null;
	return {
		get: async () => value,
		set: async (next: string) => {
			value = next;
		},
	};
}
function responseFetch(
	handler: (url: string, init: RequestInit) => Response,
): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) =>
			handler(String(input), init ?? {}),
		{ preconnect: () => {} },
	);
}

describe("EnvironmentGoogleTokenProvider OAuth", () => {
	test("performs loopback PKCE login and refreshes expired tokens through encrypted storage", async () => {
		const cache = memoryCache();
		let now = 1_000_000;
		const exchanges: URLSearchParams[] = [];
		let challenge = "";
		const services = {
			cache,
			now: () => now,
			openBrowser: async (value: string) => {
				const url = new URL(value);
				expect(url.origin).toBe("https://accounts.google.com");
				expect(url.searchParams.get("access_type")).toBe("offline");
				challenge = url.searchParams.get("code_challenge")!;
				const callback = new URL(url.searchParams.get("redirect_uri")!);
				callback.search = new URLSearchParams({
					state: url.searchParams.get("state")!,
					code: "local-auth-code",
				}).toString();
				const result = await fetch(callback);
				expect(result.status).toBe(200);
			},
			fetch: responseFetch((url, init) => {
				expect(url).toBe("https://oauth2.googleapis.com/token");
				const body = new URLSearchParams(String(init.body));
				exchanges.push(body);
				expect(init.redirect).toBe("error");
				return Response.json({
					access_token:
						exchanges.length === 1 ? "first-access" : "refreshed-access",
					expires_in: 3600,
					...(exchanges.length === 1
						? { refresh_token: "refresh-secret" }
						: {}),
				});
			}),
		};
		const provider = new EnvironmentGoogleTokenProvider(config(), services);
		expect((await provider.getToken([scope])).accessToken).toBe("first-access");
		const verifier = exchanges[0]!.get("code_verifier")!;
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(verifier),
		);
		expect(Buffer.from(digest).toString("base64url")).toBe(challenge);
		await provider.getToken([scope]);
		expect(exchanges.length).toBe(1);
		now += 4_000_000;
		expect((await provider.getToken([scope])).accessToken).toBe(
			"refreshed-access",
		);
		expect(exchanges[1]!.get("grant_type")).toBe("refresh_token");
		expect(exchanges[1]!.get("refresh_token")).toBe("refresh-secret");
		expect(JSON.parse((await cache.get())!).refreshToken).toBe(
			"refresh-secret",
		);
	});

	test("does not reuse cached tokens after changing the client identity", async () => {
		const cache = memoryCache();
		let opens = 0;
		const services = {
			cache,
			openBrowser: async (value: string) => {
				opens += 1;
				const url = new URL(value);
				const callback = new URL(url.searchParams.get("redirect_uri")!);
				callback.search = new URLSearchParams({
					state: url.searchParams.get("state")!,
					code: "code",
				}).toString();
				await fetch(callback);
			},
			fetch: responseFetch(() =>
				Response.json({
					access_token: "access",
					refresh_token: "refresh",
					expires_in: 3600,
				}),
			),
		};
		await new EnvironmentGoogleTokenProvider(
			config("first-client"),
			services,
		).getToken([scope]);
		await new EnvironmentGoogleTokenProvider(
			config("second-client"),
			services,
		).getToken([scope]);
		expect(opens).toBe(2);
	});

	test("returns actionable guidance when encrypted storage is unavailable", async () => {
		await expect(
			new EnvironmentGoogleTokenProvider(config()).getToken([scope]),
		).rejects.toThrow("encrypted profile storage");
	});

	test("does not expose Google diagnostics containing secrets", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "refresh-secret";
		const settings = config();
		settings.gmail.refreshTokenEnv = "GOOGLE_REFRESH_TOKEN";
		const provider = new EnvironmentGoogleTokenProvider(settings, {
			fetch: responseFetch(
				() => new Response("token=raw-secret", { status: 400 }),
			),
		});
		let message = "";
		try {
			await provider.getToken([scope]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("rejected");
		expect(message).not.toContain("raw-secret");
		expect(message).not.toContain("refresh-secret");
	});
});

describe("OAuth loopback callbacks", () => {
	test("rejects remote callback addresses", () => {
		expect(() =>
			validateLoopbackRedirect("http://attacker.example/oauth"),
		).toThrow("loopback");
		expect(() =>
			validateLoopbackRedirect("http://127.0.0.1@attacker.example/oauth"),
		).toThrow("loopback");
		expect(() =>
			validateLoopbackRedirect("http://127.0.0.1/oauth?token=secret"),
		).toThrow("loopback");
	});
	test("rejects callback state mismatch", async () => {
		const listener = await listenForOAuthCode(
			"http://127.0.0.1:0/oauth",
			"expected-state",
		);
		try {
			const response = await fetch(
				`${listener.redirectUri}?state=wrong-state&code=secret`,
			);
			expect(response.status).toBe(400);
			await expect(listener.code).rejects.toThrow("state did not match");
		} finally {
			listener.close();
		}
	});
	test("closes the callback server after its deadline", async () => {
		const listener = await listenForOAuthCode(
			"http://127.0.0.1:0/oauth",
			"state",
			30,
		);
		await expect(listener.code).rejects.toThrow("timed out");
		await expect(fetch(listener.redirectUri)).rejects.toThrow();
		listener.close();
	});
});
