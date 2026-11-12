import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
	CLI_SESSION_ID_HEADER,
	SERVICE_API_CREDENTIALS_PATH,
	validateCredentialName,
} from "@dg/common";
import { credentialGrantTokenPath, resolveDgPaths } from "@dg/common/node";
import { handleServiceApiCredentials } from "../../src/server/service-api";
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	credentialRequest,
	credentialResult,
	killDaemonByPidFile,
	readDaemonLog,
	removeScratchDirs,
	startWithSession,
} from "../utils/daemon-harness";

const NOT_ALLOWED = {
	ok: false,
	error: "Credential request not allowed for this caller.",
};
const BROWSER_TEXT = "refused: the service API rejects a browser Origin";
const SEEDED = {
	"a/x": "fixture-value-a-x-31f9",
	"a/y": "fixture-value-a-y-77c2",
	"ab/x": "fixture-value-ab-x-90d1",
	"b/z": "fixture-value-b-z-5e6a",
};

type Boot = Awaited<ReturnType<typeof startWithSession>>;
let daemon: Boot;
let cli: WebSocket;
let frames: unknown[];
const tokens: Record<string, string> = {};
const sockets: WebSocket[] = [];

async function cliCall(fields: Record<string, unknown>) {
	return credentialResult(frames, credentialRequest(cli, fields));
}

function tokenFile(prefix: string): string {
	return credentialGrantTokenPath(
		resolveDgPaths({ env: { DG_HOME: daemon.dgHome } }),
		prefix,
	);
}

async function grant(prefix: string): Promise<string> {
	await cliCall({ operation: "grant", prefix });
	tokens[prefix] = readFileSync(tokenFile(prefix), "utf8").trim();
	return tokens[prefix];
}

type Call = {
	method?: string;
	headers?: Record<string, string | null>;
	body?: unknown;
	rawBody?: string;
	path?: string;
	as?: string;
};

function post(call: Call = {}): Promise<Response> {
	const prefix = call.as ?? "a";
	const headers: Record<string, string | null> = {
		Host: `127.0.0.1:${daemon.port}`,
		"Content-Type": "application/json",
		[CLI_GRANT_PREFIX_HEADER]: prefix,
		[CLI_GRANT_TOKEN_HEADER]: tokens[prefix],
		...call.headers,
	};
	const sent = Object.fromEntries(
		Object.entries(headers).filter(([, v]) => v !== null),
	) as Record<string, string>;
	const method = call.method ?? "POST";
	return fetch(
		`http://127.0.0.1:${daemon.port}${call.path ?? SERVICE_API_CREDENTIALS_PATH}`,
		{
			method,
			headers: sent,
			...(method === "POST" || method === "PUT" || method === "DELETE"
				? {
						body:
							call.rawBody ??
							JSON.stringify(call.body ?? { operation: "list" }),
					}
				: {}),
		},
	);
}

function expectHardened(response: Response): void {
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

beforeAll(async () => {
	daemon = await startWithSession();
	cli = await connectCli(daemon.port, daemon.bootstrap);
	sockets.push(cli);
	frames = collectFrames(cli);
	for (const [name, value] of Object.entries(SEEDED))
		await cliCall({ operation: "set", name, value, meta: { tag: name } });
	for (const prefix of ["a", "b", "empty"]) await grant(prefix);
});

afterAll(() => {
	closeSockets(sockets);
	killDaemonByPidFile(daemon.dgHome);
	cleanupDgHome(daemon.dgHome);
	removeScratchDirs();
});

describe("POST /service-api/v1/credentials list", () => {
	it("returns only the names below the prefix, with no value field, and hardened headers", async () => {
		const response = await post();
		expect(response.status).toBe(200);
		expectHardened(response);
		const body = (await response.json()) as {
			ok: boolean;
			value: Record<string, unknown>[];
		};
		expect(body.ok).toBe(true);
		expect(body.value.map((entry) => entry.name)).toEqual(["a/x", "a/y"]);
		for (const entry of body.value) {
			expect(Object.keys(entry).sort()).toEqual(["meta", "name", "updatedAt"]);
			expect(entry).not.toHaveProperty("value");
		}
	});

	it("returns an empty array when no credential sits below the prefix", async () => {
		const response = await post({ as: "empty" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, value: [] });
	});

	it("accepts a content type with a charset parameter", async () => {
		const response = await post({
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
		expect(response.status).toBe(200);
	});

	it("marks the grant as used", async () => {
		await post();
		const grants = await cliCall({ operation: "grant-list" });
		const entry = (
			grants.value as { prefix: string; lastUsedAt: string | null }[]
		).find((g) => g.prefix === "a");
		expect(entry?.lastUsedAt).not.toBeNull();
	});
});

describe("POST /service-api/v1/credentials get", () => {
	it("returns the value, meta and updatedAt that the WebSocket path returns", async () => {
		const response = await post({ body: { operation: "get", name: "a/x" } });
		expect(response.status).toBe(200);
		expectHardened(response);
		const http = (await response.json()) as {
			ok: boolean;
			value: { value: string; meta: unknown; updatedAt: string };
		};
		expect(http.value.value).toBe(SEEDED["a/x"]);
		const socket = await cliCall({ operation: "get", name: "a/x" });
		expect(http.value).toEqual(socket.value as typeof http.value);
	});

	it("returns null for an absent name below the prefix", async () => {
		const response = await post({
			body: { operation: "get", name: "a/missing" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, value: null });
	});
});

describe("POST /service-api/v1/credentials 401", () => {
	const cases: [string, Call][] = [
		[
			"an absent grant prefix header",
			{ headers: { [CLI_GRANT_PREFIX_HEADER]: null } },
		],
		[
			"an absent grant token header",
			{ headers: { [CLI_GRANT_TOKEN_HEADER]: null } },
		],
		["an unknown prefix", { headers: { [CLI_GRANT_PREFIX_HEADER]: "nobody" } }],
		[
			"an incorrect token",
			{ headers: { [CLI_GRANT_TOKEN_HEADER]: "wrong-token" } },
		],
		[
			"the token of another prefix",
			{ headers: { [CLI_GRANT_PREFIX_HEADER]: "b" } },
		],
		[
			"a session id header beside a valid grant",
			{ headers: { [CLI_SESSION_ID_HEADER]: "any-session" } },
		],
		[
			"a malformed prefix header",
			{ headers: { [CLI_GRANT_PREFIX_HEADER]: "A/../b" } },
		],
	];
	for (const [label, call] of cases)
		it(`answers 401 with the not-allowed body for ${label}`, async () => {
			const response = await post(call);
			expect(response.status).toBe(401);
			expectHardened(response);
			expect(await response.json()).toEqual(NOT_ALLOWED);
		});

	it("answers 401 before it checks the content type", async () => {
		const response = await post({
			headers: {
				[CLI_GRANT_TOKEN_HEADER]: "wrong",
				"Content-Type": "text/plain",
			},
		});
		expect(response.status).toBe(401);
	});

	it("takes the prefix for the read from the header, so a token of b never reads a", async () => {
		const response = await post({
			as: "b",
			body: { operation: "get", name: "a/x" },
		});
		expect(response.status).toBe(403);
		expect(JSON.stringify(await response.json())).not.toContain(SEEDED["a/x"]);
	});
});

describe("POST /service-api/v1/credentials 403", () => {
	it("refuses a name outside the prefix and an operation that is not get or list", async () => {
		const before = (await cliCall({ operation: "list" })).value;
		const bodies = [
			{ operation: "get", name: "b/z" },
			{ operation: "get", name: "ab/x" },
			{ operation: "get", name: "a" },
			{ operation: "set", name: "a/new", value: "v", meta: {} },
			{ operation: "delete", name: "a/x" },
			{ operation: "grant", prefix: "a" },
			{ operation: "revoke", prefix: "a" },
			{ operation: "grant-list" },
			{ operation: "unknown-operation" },
		];
		for (const body of bodies) {
			const response = await post({ body });
			expect(response.status).toBe(403);
			expectHardened(response);
			expect(await response.json()).toEqual(NOT_ALLOWED);
		}
		expect((await cliCall({ operation: "list" })).value).toEqual(before);
		expect(
			(await cliCall({ operation: "get", name: "a/x" })).value,
		).toMatchObject({ value: SEEDED["a/x"] });
		expect(
			((await cliCall({ operation: "grant-list" })).value as unknown[]).length,
		).toBe(3);
	});

	it("checks the operation before the extra body keys", async () => {
		const response = await post({
			body: { operation: "set", name: "a/x", value: "v", prefix: "b" },
		});
		expect(response.status).toBe(403);
	});

	it("checks the name prefix before the name syntax", async () => {
		const response = await post({
			body: { operation: "get", name: "b/UPPER CASE" },
		});
		expect(response.status).toBe(403);
	});
});

describe("POST /service-api/v1/credentials 400 JSON", () => {
	const reasonOf = async (call: Call) => {
		const response = await post(call);
		expect(response.status).toBe(400);
		expectHardened(response);
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		return body.error;
	};

	it("rejects a body that is not a JSON object", async () => {
		for (const rawBody of ["[]", "null", '"text"', "7", "{not json"])
			expect(await reasonOf({ rawBody })).toBe(
				"request body must be a JSON object",
			);
	});

	it("rejects an operation that is not a string", async () => {
		for (const body of [
			{},
			{ operation: 1 },
			{ operation: null },
			{ operation: ["list"] },
		])
			expect(await reasonOf({ body })).toBe('"operation" must be a string');
	});

	it("rejects a get with an absent or non-string name", async () => {
		for (const body of [
			{ operation: "get" },
			{ operation: "get", name: 5 },
			{ operation: "get", name: null },
		])
			expect(await reasonOf({ body })).toBe('"name" must be a string');
	});

	it("rejects a name below the prefix that the credential name rules refuse", async () => {
		const name = "a/Not Valid";
		let expected = "";
		try {
			validateCredentialName(name);
		} catch (err) {
			expected = (err as Error).message;
		}
		expect(expected).not.toBe("");
		expect(await reasonOf({ body: { operation: "get", name } })).toBe(expected);
	});

	it("rejects a body key that the operation does not support", async () => {
		for (const [body, key] of [
			[{ operation: "list", prefix: "b" }, "prefix"],
			[{ operation: "list", grant: { prefix: "b", token: "t" } }, "grant"],
			[{ operation: "list", name: "a/x" }, "name"],
			[{ operation: "get", name: "a/x", prefix: "b" }, "prefix"],
			[{ operation: "get", name: "a/x", grant: {} }, "grant"],
			[{ operation: "get", name: "a/x", value: "v" }, "value"],
		] as const)
			expect(await reasonOf({ body })).toBe(
				`request body key "${key}" is not supported`,
			);
	});

	it("never echoes a part of the body or of a header value, in the response or the log", async () => {
		const marker = "echo-marker-5b0c93e1";
		const responses = [
			await post({ body: { operation: marker } }),
			await post({ body: { operation: "list", [marker]: marker } }),
			await post({
				body: { operation: "get", name: `a/${marker.toUpperCase()}` },
			}),
			await post({
				headers: { "X-Marker": marker },
				body: { operation: "get", name: 5, extra: marker },
			}),
		];
		for (const response of responses)
			expect((await response.text()).toLowerCase()).not.toContain(marker);
		expect(readDaemonLog(daemon.dgHome).toLowerCase()).not.toContain(marker);
	});
});

describe("POST /service-api/v1/credentials content type and Origin", () => {
	it("answers 415 with the plain text for another content type", async () => {
		for (const contentType of [
			"text/plain",
			"application/x-www-form-urlencoded",
		]) {
			const response = await post({ headers: { "Content-Type": contentType } });
			expect(response.status).toBe(415);
			expectHardened(response);
			expect(await response.text()).toBe(
				"Content-Type must be application/json",
			);
		}
	});

	it("answers 413 for a body above the cap", async () => {
		const response = await post({
			body: { operation: "list", pad: "x".repeat(70 * 1024) },
		});
		expect(response.status).toBe(413);
		expectHardened(response);
	});

	it("answers 415 for a body that names no JSON content type", async () => {
		const response = await post({ headers: { "Content-Type": null } });
		expect(response.status).toBe(415);
	});

	it("answers 400 with the plain text for a browser Origin, even with a valid grant", async () => {
		const response = await post({
			headers: { Origin: "https://evil.example" },
		});
		expect(response.status).toBe(400);
		expectHardened(response);
		expect(await response.text()).toBe(BROWSER_TEXT);
	});

	it("checks the browser Origin before the grant", async () => {
		const response = await post({
			headers: {
				Origin: "https://evil.example",
				[CLI_GRANT_TOKEN_HEADER]: null,
			},
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toBe(BROWSER_TEXT);
	});

	it("refuses a Host header that is not the loopback authority", async () => {
		const response = await post({ headers: { Host: "evil.example" } });
		expect(response.status).toBe(400);
	});
});

describe("service API routing", () => {
	it("answers 404 with the hardened headers for each method other than POST", async () => {
		for (const method of ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
			const response = await post({ method });
			expect(response.status).toBe(404);
			expectHardened(response);
		}
	});

	it("answers the server 404 for a trailing slash and a sibling path", async () => {
		for (const path of [
			`${SERVICE_API_CREDENTIALS_PATH}/`,
			"/service-api/v1/other",
		]) {
			const response = await post({ path });
			expect(response.status).toBe(404);
		}
	});
});

describe("service API grant lifecycle", () => {
	it("answers 401 for the same token after revoke", async () => {
		await grant("gone");
		await cliCall({
			operation: "set",
			name: "gone/v",
			value: "gone-fixture-1a2b",
			meta: {},
		});
		expect((await post({ as: "gone" })).status).toBe(200);
		await cliCall({ operation: "revoke", prefix: "gone" });
		const response = await post({ as: "gone" });
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual(NOT_ALLOWED);
	});

	it("answers 401 for the old token after a new grant replaces it", async () => {
		const old = await grant("rot");
		await grant("rot");
		const response = await post({
			as: "rot",
			headers: { [CLI_GRANT_TOKEN_HEADER]: old },
		});
		expect(response.status).toBe(401);
		expect((await post({ as: "rot" })).status).toBe(200);
	});
});

describe("service API secrecy", () => {
	it("leaves no token and no credential value in the daemon log", async () => {
		await post({ body: { operation: "get", name: "a/x" } });
		const log = readDaemonLog(daemon.dgHome);
		for (const secret of [...Object.values(tokens), ...Object.values(SEEDED)])
			expect(log).not.toContain(secret);
	});
});

describe("handleServiceApiCredentials with a failing store", () => {
	function failingStoreRequest(logger: { error: (message: string) => void }) {
		const store = {
			verifyCredentialGrant: () => true,
			listCredentials: () => {
				throw new Error("disk failure marker");
			},
			getCredential: () => undefined,
		};
		return handleServiceApiCredentials(
			new Request("http://127.0.0.1/service-api/v1/credentials", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					[CLI_GRANT_PREFIX_HEADER]: "a",
					[CLI_GRANT_TOKEN_HEADER]: "t",
				},
				body: JSON.stringify({ operation: "list" }),
			}),
			store,
			logger,
		);
	}

	it("logs only the error name when the store throws", async () => {
		const logged: string[] = [];

		await failingStoreRequest({
			error: (message) => void logged.push(message),
		});

		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("Error");
		expect(logged[0]).not.toContain("disk failure marker");
		expect(logged[0]).not.toContain(CLI_GRANT_PREFIX_HEADER);
	});

	it("answers 500 with the storage text when the store throws", async () => {
		const response = await failingStoreRequest({ error: () => {} });
		expect(response.status).toBe(500);
		expectHardened(response);
		expect(await response.json()).toEqual({
			ok: false,
			error:
				"Credential storage failed; check daemon health and encryption key access.",
		});
	});
});

describe("service-api.ts imports", () => {
	it("imports nothing from http.ts", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../src/server/service-api.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/from\s+["']\.\/http["']/);
	});
});
