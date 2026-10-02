import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../config/defaults";
import { EnvironmentGoogleTokenProvider } from "../auth";
import {
	listenForOAuthCode,
	openOAuthBrowser,
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
	const writes: string[] = [];
	return {
		writes,
		get: async () => value,
		set: async (next: string) => {
			writes.push(next);
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
	test("returns after spawning a configured opener without supervising its exit status", async () => {
		const home = await mkdtemp(join(tmpdir(), "dg-gmail-opener-exit-"));
		const openerPath = join(home, "fail.ts");
		const markerPath = join(home, "exit.txt");
		await Bun.write(
			openerPath,
			`await Bun.write(${JSON.stringify(markerPath)}, "7"); process.exit(7);`,
		);
		try {
			await expect(
				openOAuthBrowser(
					"https://accounts.google.com/o/oauth2/v2/auth",
					`${process.execPath} ${openerPath}`,
				),
			).resolves.toBeUndefined();
			expect(await waitForFixtureFile(markerPath)).toBe("7");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
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

async function completeLogin(value: string): Promise<void> {
	const url = new URL(value);
	const callback = new URL(url.searchParams.get("redirect_uri")!);
	callback.search = new URLSearchParams({
		state: url.searchParams.get("state")!,
		code: "fixture-authorization-code",
	}).toString();
	const response = await fetch(callback);
	expect(response.status).toBe(200);
}

async function expiredLogin() {
	const settings = config();
	settings.gmail.authMode = "browser";
	const cache = memoryCache();
	let now = 1_000_000;
	await new EnvironmentGoogleTokenProvider(settings, {
		cache,
		now: () => now,
		openBrowser: completeLogin,
		fetch: responseFetch(() =>
			Response.json({
				access_token: "fixture-expired-access",
				refresh_token: "fixture-revoked-refresh",
				expires_in: 3600,
			}),
		),
	}).getToken([scope]);
	now += 4_000_000;
	cache.writes.length = 0;
	return {
		settings,
		cache,
		now: () => now,
		originalCache: (await cache.get())!,
	};
}

const rawDiagnostic = "fixture-provider-secret private@example.test";
const rejectedRefresh = (status = 400, error = "invalid_grant") =>
	Response.json({ error, error_description: rawDiagnostic }, { status });

async function failureMessage(pending: Promise<unknown>): Promise<string> {
	try {
		await pending;
		throw new Error("Expected authentication to fail");
	} catch (error) {
		const message = (error as Error).message;
		expect(message).not.toBe("Expected authentication to fail");
		return message;
	}
}

function manualLoginOutput(completeCallback = true) {
	const lines: string[] = [];
	const urls: string[] = [];
	const callbacks: Promise<void>[] = [];
	const spy = spyOn(console, "error").mockImplementation(
		(...values: unknown[]) => {
			const line = values.map(String).join(" ");
			lines.push(line);
			const url = line.match(/https:\/\/accounts\.google\.com\/[^\s]+/)?.[0];
			if (url) urls.push(url);
			if (url && completeCallback) callbacks.push(completeLogin(url));
		},
	);
	return { lines, urls, callbacks, close: () => spy.mockRestore() };
}

describe("EnvironmentGoogleTokenProvider refresh recovery", () => {
	test("replaces a revoked cached refresh token through a fresh PKCE browser login", async () => {
		const fixture = await expiredLogin();
		const grants: URLSearchParams[] = [];
		let opened = "";
		let cacheWhenOpened = "";
		const provider = new EnvironmentGoogleTokenProvider(fixture.settings, {
			cache: fixture.cache,
			now: fixture.now,
			openBrowser: async (url) => {
				opened = url;
				cacheWhenOpened = (await fixture.cache.get()) ?? "";
				await completeLogin(url);
			},
			fetch: responseFetch((_url, init) => {
				const grant = new URLSearchParams(String(init.body));
				grants.push(grant);
				return grant.get("grant_type") === "refresh_token"
					? rejectedRefresh()
					: Response.json({
							access_token: "fixture-new-access",
							refresh_token: "fixture-new-refresh",
							expires_in: 3600,
						});
			}),
		});
		expect((await provider.getToken([scope])).accessToken).toBe(
			"fixture-new-access",
		);
		expect(grants.map((grant) => grant.get("grant_type"))).toEqual([
			"refresh_token",
			"authorization_code",
		]);
		expect(cacheWhenOpened).not.toContain("fixture-revoked-refresh");
		expect(cacheWhenOpened).not.toContain("fixture-expired-access");
		expect(new URL(opened).searchParams.get("code_challenge_method")).toBe(
			"S256",
		);
		const verifier = grants[1]!.get("code_verifier")!;
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(verifier),
		);
		expect(new URL(opened).searchParams.get("code_challenge")).toBe(
			Buffer.from(digest).toString("base64url"),
		);
		expect(JSON.parse((await fixture.cache.get())!).refreshToken).toBe(
			"fixture-new-refresh",
		);
	});

	test.each([
		{ name: "server error", response: () => rejectedRefresh(503) },
		{
			name: "unrelated client error",
			response: () => rejectedRefresh(400, "invalid_client"),
		},
		{
			name: "invalid grant with another status",
			response: () => rejectedRefresh(401),
		},
		{
			name: "malformed response",
			response: () => new Response(rawDiagnostic, { status: 400 }),
		},
		{
			name: "network error",
			response: (): Response => {
				throw new Error(rawDiagnostic);
			},
		},
	])(
		"preserves cached credentials and does not open a browser after $name",
		async ({ response }) => {
			const fixture = await expiredLogin();
			let opens = 0;
			const provider = new EnvironmentGoogleTokenProvider(fixture.settings, {
				cache: fixture.cache,
				now: fixture.now,
				openBrowser: async () => {
					opens += 1;
				},
				fetch: responseFetch(response),
			});
			const message = await failureMessage(provider.getToken([scope]));
			expect(message).not.toContain(rawDiagnostic);
			expect(message).not.toContain("fixture-revoked-refresh");
			expect(await fixture.cache.get()).toBe(fixture.originalCache);
			expect(fixture.cache.writes).toEqual([]);
			expect(opens).toBe(0);
		},
	);

	test.each([{ authMode: "browser" as const }, { authMode: "env" as const }])(
		"does not invalidate an environment refresh token in $authMode mode",
		async ({ authMode }) => {
			const fixture = await expiredLogin();
			fixture.settings.gmail.authMode = authMode;
			fixture.settings.gmail.refreshTokenEnv = "GOOGLE_REFRESH_TOKEN";
			process.env.GOOGLE_REFRESH_TOKEN = "fixture-environment-refresh";
			let opens = 0;
			const grants: URLSearchParams[] = [];
			const message = await failureMessage(
				new EnvironmentGoogleTokenProvider(fixture.settings, {
					cache: fixture.cache,
					now: fixture.now,
					openBrowser: async () => {
						opens += 1;
					},
					fetch: responseFetch((_url, init) => {
						grants.push(new URLSearchParams(String(init.body)));
						return rejectedRefresh();
					}),
				}).getToken([scope]),
			);
			expect(grants[0]!.get("refresh_token")).toBe(
				"fixture-environment-refresh",
			);
			expect(process.env.GOOGLE_REFRESH_TOKEN).toBe(
				"fixture-environment-refresh",
			);
			expect(await fixture.cache.get()).toBe(fixture.originalCache);
			expect(fixture.cache.writes).toEqual([]);
			expect(opens).toBe(0);
			expect(message).not.toContain(rawDiagnostic);
		},
	);

	test("never falls back to a browser when a cached token is revoked in env mode", async () => {
		const fixture = await expiredLogin();
		fixture.settings.gmail.authMode = "env";
		let opens = 0;
		await failureMessage(
			new EnvironmentGoogleTokenProvider(fixture.settings, {
				cache: fixture.cache,
				now: fixture.now,
				openBrowser: async () => {
					opens += 1;
				},
				fetch: responseFetch(() => rejectedRefresh()),
			}).getToken([scope]),
		);
		expect(opens).toBe(0);
	});
});

describe("EnvironmentGoogleTokenProvider browser launch", () => {
	test("loads the Gmail opener command from its environment setting", async () => {
		const defaultsPath = new URL("../../config/defaults.ts", import.meta.url)
			.pathname;
		const command = "fixture-browser --new-window";
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`import {defaultConfig} from ${JSON.stringify(defaultsPath)}; console.log(JSON.stringify({command: defaultConfig.gmail.openBrowserCommand}));`,
			],
			{
				env: { ...process.env, GOOGLE_BROWSER_OPEN_COMMAND: command },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stdout = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(JSON.parse(stdout).command).toBe(command);
	});
	test("passes the authorization URL to the configured opener executable", async () => {
		const home = await mkdtemp(join(tmpdir(), "dg-gmail-opener-"));
		const outputPath = join(home, "opened-url.txt");
		const openerPath = join(home, "open.ts");
		await Bun.write(
			openerPath,
			`const [output, value] = process.argv.slice(2); await Bun.write(output!, value!); const url = new URL(value!); const callback = new URL(url.searchParams.get("redirect_uri")!); callback.search = new URLSearchParams({state: url.searchParams.get("state")!, code: "fixture-authorization-code"}).toString(); const result = await fetch(callback); if (result.status !== 200) process.exit(1);`,
		);
		const settings = config();
		settings.gmail = {
			...settings.gmail,
			...{
				openBrowserCommand: `${process.execPath} ${openerPath} ${outputPath}`,
			},
		};
		const output = manualLoginOutput(false);
		const previousPath = process.env.PATH;
		process.env.PATH = home;
		try {
			const result = await new EnvironmentGoogleTokenProvider(settings, {
				cache: memoryCache(),
				timeoutMs: 2000,
				fetch: responseFetch(() =>
					Response.json({ access_token: "fixture-access", expires_in: 3600 }),
				),
			}).getToken([scope]);
			expect(result.accessToken).toBe("fixture-access");
			const url = new URL(await Bun.file(outputPath).text());
			expect(url.origin).toBe("https://accounts.google.com");
			expect(url.searchParams.get("client_id")).toBe(settings.gmail.clientId!);
			expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		} finally {
			output.close();
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			await rm(home, { recursive: true, force: true });
		}
	});

	test.each([
		{ kind: "missing executable" },
		{ kind: "injected opener rejection" },
		{ kind: "nonzero opener exit" },
		{ kind: "zero exit without a browser" },
		{ kind: "delayed nonzero opener exit" },
	])(
		"prints a private-safe manual authorization URL and completes the callback after $kind",
		async ({ kind }) => {
			const home = await mkdtemp(join(tmpdir(), "dg-gmail-failed-opener-"));
			const openerPath = join(home, "fail.ts");
			const markerPath = join(home, "exit.txt");
			const exitCode = kind === "zero exit without a browser" ? 0 : 7;
			await Bun.write(
				openerPath,
				`await Bun.sleep(${kind === "delayed nonzero opener exit" ? 750 : 0}); await Bun.write(${JSON.stringify(markerPath)}, String(${exitCode})); process.exit(${exitCode});`,
			);
			const settings = config();
			settings.gmail.loginHint = "private@example.test";
			settings.gmail.clientSecret = "fixture-client-secret";
			settings.gmail.clientSecretEnv = undefined;
			settings.gmail = {
				...settings.gmail,
				...{
					openBrowserCommand:
						kind !== "missing executable" &&
						kind !== "injected opener rejection"
							? `${process.execPath} ${openerPath}`
							: "/nonexistent/dg-gmail-fixture-opener",
				},
			};
			const output = manualLoginOutput();
			const previousPath = process.env.PATH;
			process.env.PATH = "/nonexistent/dg-gmail-fixture-path";
			try {
				const result = await new EnvironmentGoogleTokenProvider(settings, {
					cache: memoryCache(),
					timeoutMs: 2000,
					...(kind === "injected opener rejection"
						? {
								openBrowser: async () => {
									throw new Error(rawDiagnostic);
								},
							}
						: {}),
					fetch: responseFetch(() =>
						Response.json({
							access_token: "fixture-access-secret",
							refresh_token: "fixture-refresh-secret",
							expires_in: 3600,
						}),
					),
				}).getToken([scope]);
				await Promise.all(output.callbacks);
				expect(result.accessToken).toBe("fixture-access-secret");
				expect(output.callbacks).toHaveLength(1);
				expect(new URL(output.urls[0]!).searchParams.has("login_hint")).toBe(
					false,
				);
				if (
					kind !== "missing executable" &&
					kind !== "injected opener rejection"
				)
					expect(await waitForFixtureFile(markerPath)).toBe(String(exitCode));
				const text = output.lines.join("\n");
				expect(text).toContain("https://accounts.google.com/");
				expect(text.length).toBeLessThan(4096);
				for (const privateValue of [
					settings.gmail.loginHint,
					settings.gmail.clientSecret,
					"fixture-access-secret",
					"fixture-refresh-secret",
					rawDiagnostic,
				])
					expect(text).not.toContain(privateValue);
			} finally {
				output.close();
				await rm(home, { recursive: true, force: true });
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
			}
		},
	);
});

async function waitForFixtureFile(path: string): Promise<string> {
	const deadline = Date.now() + 2000;
	while (!(await Bun.file(path).exists()) && Date.now() < deadline)
		await Bun.sleep(10);
	return Bun.file(path).text();
}
