import { afterEach, describe, expect, it } from "bun:test";
import {
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
	clearNotedSecrets,
	redactText,
	SECRET_CODE_HEADER,
	SECRET_INTAKE_PATH,
	SECRET_PAGE_PATH,
} from "@dg/common";
import { readCredentialGrantToken, resolveDgPaths } from "@dg/common/node";
import { createAttachLimiter } from "../../src/server/attach-limiter";
import { createPageCodes, SECRET_INTENT_TTL_MS } from "../../src/server/page-codes";
import {
	handleSecretIntake,
	handleSecretName,
	type SecretIntent,
} from "../../src/server/secret-intake";
import {
	cleanupDgHome,
	collectFrames,
	connectCli,
	credentialRequest,
	credentialResult,
	closeSockets,
	killDaemonByPidFile,
	readDaemonLog,
	removeScratchDirs,
	scanFileForBytes,
	startWithSession,
	waitForOpen,
} from "../utils/daemon-harness";

const VALUE = "fixture-typed-password-9c41e7";
const META = { engine: "postgresql", host: "10.9.8.7", readOnly: "true" };
const sockets: WebSocket[] = [];
let dgHome: string | undefined;

afterEach(() => {
	clearNotedSecrets();
	closeSockets(sockets);
	if (dgHome) {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	}
	removeScratchDirs();
	dgHome = undefined;
});

async function boot() {
	const started = await startWithSession();
	dgHome = started.dgHome;
	const cli = await connectCli(started.port, started.bootstrap);
	sockets.push(cli);
	const results = collectFrames(cli);
	const origin = `http://127.0.0.1:${started.port}`;

	async function intake(name = "db/pg1", meta: Record<string, unknown> = META) {
		const answer = await credentialResult(
			results,
			credentialRequest(cli, { operation: "intake", name, meta }),
		);
		expect(answer.ok).toBe(true);
		const reply = answer.value as { url: string; expiresAt: string };
		return { ...reply, code: new URL(reply.url).hash.slice("#code=".length) };
	}

	async function stored(name = "db/pg1") {
		const answer = await credentialResult(
			results,
			credentialRequest(cli, { operation: "get", name }),
		);
		return answer.value as { value: string; meta: unknown } | null;
	}

	function submit(
		body: unknown,
		options: { origin?: string | null; host?: string } = {},
	) {
		const sentOrigin = options.origin === undefined ? origin : options.origin;
		return fetch(`${origin}${SECRET_INTAKE_PATH}`, {
			method: "POST",
			headers: {
				Host: options.host ?? `127.0.0.1:${started.port}`,
				"Content-Type": "application/json",
				...(sentOrigin === null ? {} : { Origin: sentOrigin }),
			},
			body: JSON.stringify(body),
		});
	}

	function readName(code: string, headers: Record<string, string> = {}) {
		return fetch(`${origin}${SECRET_INTAKE_PATH}`, {
			headers: { [SECRET_CODE_HEADER]: code, ...headers },
		});
	}

	return { ...started, cli, results, origin, intake, stored, submit, readName };
}

describe("credentials intake operation", () => {
	it("replies with a loopback page url holding a one-time code and a 120 second expiry, and no session token", async () => {
		const { port, bootstrap, results, cli } = await boot();
		const before = Date.now();

		const answer = await credentialResult(
			results,
			credentialRequest(cli, { operation: "intake", name: "db/pg1", meta: META }),
		);

		expect(answer.ok).toBe(true);
		const { url, expiresAt } = answer.value as { url: string; expiresAt: string };
		expect(url).toMatch(
			new RegExp(`^http://127\\.0\\.0\\.1:${port}${SECRET_PAGE_PATH}#code=[A-Za-z0-9_-]{32,}$`),
		);
		const lifetime = Date.parse(expiresAt) - before;
		expect(lifetime).toBeGreaterThan(SECRET_INTENT_TTL_MS - 5_000);
		expect(lifetime).toBeLessThanOrEqual(SECRET_INTENT_TTL_MS + 5_000);
		const text = JSON.stringify(answer.value);
		expect(text).not.toContain(bootstrap.token);
		expect(text).not.toContain(bootstrap.sessionId);
		expect(text).not.toContain("10.9.8.7");
	});

	it("mints a different code each time", async () => {
		const { intake } = await boot();

		expect((await intake()).code).not.toBe((await intake()).code);
	});

	it("refuses a bad name or secret-like meta and mints nothing", async () => {
		const { results, cli } = await boot();

		for (const fields of [
			{ name: "bad name", meta: {} },
			{ name: "db/pg1", meta: { password: "fixture-secret-value" } },
			{ name: "db/pg1" },
			{ name: "db/pg1", meta: {}, value: VALUE },
		]) {
			const answer = await credentialResult(
				results,
				credentialRequest(cli, { operation: "intake", ...fields }),
			);
			expect(answer.ok).toBe(false);
			expect(JSON.stringify(answer)).not.toContain(VALUE);
		}
	});

	it("refuses a service grant, which is read-only under one prefix", async () => {
		const { port, results, cli } = await boot();
		const prefix = "reader";
		const granted = await credentialResult(
			results,
			credentialRequest(cli, { operation: "grant", prefix }),
		);
		expect(granted.ok).toBe(true);
		const token = readCredentialGrantToken(
			resolveDgPaths({ env: { DG_HOME: dgHome! } }),
			prefix,
		);
		const Ctor = WebSocket as unknown as new (
			url: string,
			options: { headers: Record<string, string> },
		) => WebSocket;
		const grantSocket = new Ctor(`ws://127.0.0.1:${port}/cli`, {
			headers: {
				[CLI_GRANT_PREFIX_HEADER]: prefix,
				[CLI_GRANT_TOKEN_HEADER]: token,
			},
		});
		sockets.push(grantSocket);
		await waitForOpen(grantSocket);
		const grantResults = collectFrames(grantSocket);

		const answer = await credentialResult(
			grantResults,
			credentialRequest(grantSocket, {
				operation: "intake",
				name: "db/pg1",
				meta: {},
				grant: { prefix, token },
			}),
		);

		expect(answer.ok).toBe(false);
	});
});

describe("GET /secret page shell", () => {
	it("serves html and script with the chat CSP and framing headers and no session token", async () => {
		const { port, bootstrap, origin } = await boot();

		const html = await fetch(`${origin}${SECRET_PAGE_PATH}`);
		const script = await fetch(`${origin}${SECRET_PAGE_PATH}.js`);

		expect(html.status).toBe(200);
		expect(html.headers.get("Content-Type")).toStartWith("text/html");
		expect(html.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(html.headers.get("X-Frame-Options")).toBe("DENY");
		expect(html.headers.get("Cache-Control")).toBe("no-store");
		const csp = html.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${port}`);
		const chat = await fetch(`${origin}/chat`);
		expect(csp).toBe(chat.headers.get("Content-Security-Policy") ?? "");
		expect(script.status).toBe(200);
		expect(script.headers.get("Content-Type")).toStartWith("text/javascript");
		expect(script.headers.get("X-Content-Type-Options")).toBe("nosniff");
		for (const text of [await html.text(), await script.text()]) {
			expect(text).not.toContain(bootstrap.token);
			expect(text).not.toContain(bootstrap.sessionId);
		}
	});

	it("refuses the page with a foreign Host header", async () => {
		const { origin } = await boot();

		const response = await fetch(`${origin}${SECRET_PAGE_PATH}`, {
			headers: { Host: "evil.example" },
		});

		expect(response.status).toBe(400);
	});
});

describe("GET /secret-intake", () => {
	it("tells the page only the credential name and leaves the code redeemable", async () => {
		const { intake, readName, submit, stored, bootstrap } = await boot();
		const { code } = await intake();

		const first = await readName(code);
		const second = await readName(code);

		expect(first.status).toBe(200);
		expect(first.headers.get("Cache-Control")).toBe("no-store");
		expect(await first.json()).toEqual({ name: "db/pg1" });
		const text = await second.text();
		for (const hidden of ["10.9.8.7", "postgresql", bootstrap.token, bootstrap.sessionId])
			expect(text).not.toContain(hidden);
		expect((await submit({ code, value: VALUE })).status).toBe(204);
		expect(await stored()).not.toBeNull();
	});

	it("answers 404 for an unknown or spent code and 400 for a foreign Origin", async () => {
		const { intake, readName, submit } = await boot();
		const { code } = await intake();

		expect((await readName("nope")).status).toBe(404);
		expect((await readName("")).status).toBe(404);
		expect((await readName(code, { Origin: "https://evil.example" })).status).toBe(400);
		expect((await submit({ code, value: VALUE })).status).toBe(204);
		expect((await readName(code)).status).toBe(404);
	});
});

describe("POST /secret-intake", () => {
	it("stores the value under the intent's name and meta and replies 204", async () => {
		const { intake, submit, stored } = await boot();
		const { code } = await intake("db/pg1", META);

		const response = await submit({ code, value: VALUE });

		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(await stored("db/pg1")).toMatchObject({ value: VALUE, meta: META });
	});

	it("moves the credential's updatedAt in the list on every submit, without listing the value", async () => {
		const { intake, submit, results, cli } = await boot();
		const updatedAt = async () => {
			const answer = await credentialResult(
				results,
				credentialRequest(cli, { operation: "list" }),
			);
			expect(JSON.stringify(answer)).not.toContain(VALUE);
			return (answer.value as { name: string; updatedAt: string }[]).find(
				(entry) => entry.name === "db/pg1",
			)?.updatedAt;
		};
		expect(await updatedAt()).toBeUndefined();

		await submit({ code: (await intake()).code, value: VALUE });
		const first = await updatedAt();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await submit({ code: (await intake()).code, value: `${VALUE}-again` });
		const second = await updatedAt();

		expect(first).toBeString();
		expect(second).toBeString();
		expect(second).not.toBe(first);
	});

	it("redeems the code once: a second submit and a read after it answer 404", async () => {
		const { intake, submit, stored, readName } = await boot();
		const { code } = await intake();
		await submit({ code, value: VALUE });

		const again = await submit({ code, value: "fixture-second-value-77aa" });

		expect(again.status).toBe(404);
		expect((await readName(code)).status).toBe(404);
		expect(await stored()).toMatchObject({ value: VALUE });
	});

	it("refuses a foreign or missing Origin and stores nothing", async () => {
		const { intake, submit, stored } = await boot();
		const { code } = await intake();

		for (const origin of ["https://evil.example", "http://127.0.0.1:1", "null", null]) {
			const response = await submit({ code, value: VALUE }, { origin });
			expect(response.status).toBe(400);
		}

		expect(await stored()).toBeNull();
		expect((await submit({ code, value: VALUE })).status).toBe(204);
	});

	it("refuses a non-loopback Host header and stores nothing", async () => {
		const { intake, submit, stored } = await boot();
		const { code } = await intake();

		const response = await submit({ code, value: VALUE }, { host: "evil.example" });

		expect(response.status).toBe(400);
		expect(await stored()).toBeNull();
	});

	it("answers 404 for a code it never minted and stores nothing", async () => {
		const { intake, submit, stored } = await boot();
		await intake();

		const response = await submit({ code: "never-minted", value: VALUE });

		expect(response.status).toBe(404);
		expect(await stored()).toBeNull();
	});

	it("keeps the code usable after a malformed body, so a typo does not burn it", async () => {
		const { intake, submit, stored } = await boot();
		const { code } = await intake();

		for (const body of [
			{ code },
			{ code, value: "" },
			{ code, value: 7 },
			{ code, value: "x".repeat(70_000) },
			{ value: VALUE },
			{ code: 5, value: VALUE },
		]) {
			expect((await submit(body)).status).toBe(400);
		}

		expect(await stored()).toBeNull();
		expect((await submit({ code, value: VALUE })).status).toBe(204);
	});

	it("keeps the submitted value out of the daemon log and the database file", async () => {
		const { intake, submit, stored } = await boot();
		const { code } = await intake();
		expect((await submit({ code: "never-minted", value: `${VALUE}-refused` })).status).toBe(404);
		expect((await submit({ code, value: VALUE })).status).toBe(204);
		expect(await stored()).toMatchObject({ value: VALUE });

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome! } });
		const log = readDaemonLog(dgHome!);

		expect(log).not.toContain(VALUE);
		expect(log).not.toContain(code);
		expect(scanFileForBytes(paths.dbPath, VALUE)).toBe(false);
	});
});

describe("secret intake handlers", () => {
	const port = 47_999;
	const origin = `http://127.0.0.1:${port}`;
	const intent: SecretIntent = { name: "db/pg1", meta: { engine: "postgresql" } };

	function setup() {
		const stored: { name: string; value: string; meta: unknown }[] = [];
		const credentials = {
			setCredential(name: string, value: string, meta: unknown) {
				stored.push({ name, value, meta });
			},
		};
		const codes = createPageCodes<SecretIntent>({ ttlMs: SECRET_INTENT_TTL_MS });
		const limiter = createAttachLimiter();
		const post = (body: unknown) =>
			handleSecretIntake(
				new Request(`${origin}${SECRET_INTAKE_PATH}`, {
					method: "POST",
					headers: { Origin: origin, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				{ port, credentials },
				codes,
				limiter,
			);
		return { stored, credentials, codes, limiter, post };
	}

	it("notes the submitted value so log redaction masks it, even when the code is refused", async () => {
		const { post } = setup();

		const response = await post({ code: "never-minted", value: VALUE });

		expect(response.status).toBe(404);
		const line = redactText(`submit failed for ${VALUE}`);
		expect(line).not.toContain(VALUE);
		expect(line).toContain("[redacted]");
	});

	it("answers 429 once the limiter cap is spent and stores nothing for a valid code", async () => {
		const { post, codes, stored } = setup();
		for (let attempt = 0; attempt < 30; attempt++)
			expect((await post({ code: "never-minted", value: VALUE })).status).toBe(404);
		const code = codes.mint(intent);

		const response = await post({ code, value: VALUE });

		expect(response.status).toBe(429);
		expect(stored).toEqual([]);
	});

	it("answers a storage failure with a fixed message that does not echo the value", async () => {
		const { codes, limiter } = setup();
		const code = codes.mint(intent);
		const credentials = {
			setCredential() {
				throw new Error(`could not write ${VALUE}`);
			},
		};

		const response = await handleSecretIntake(
			new Request(`${origin}${SECRET_INTAKE_PATH}`, {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body: JSON.stringify({ code, value: VALUE }),
			}),
			{ port, credentials },
			codes,
			limiter,
		);

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain(VALUE);
	});

	it("name lookup answers 429 once the shared limiter cap is spent", () => {
		const { codes, limiter } = setup();
		const code = codes.mint(intent);
		const get = () =>
			handleSecretName(
				new Request(`${origin}${SECRET_INTAKE_PATH}`, {
					headers: { [SECRET_CODE_HEADER]: code },
				}),
				{ port },
				codes,
				limiter,
			);

		for (let attempt = 0; attempt < 30; attempt++) expect(get().status).toBe(200);

		expect(get().status).toBe(429);
	});
});
