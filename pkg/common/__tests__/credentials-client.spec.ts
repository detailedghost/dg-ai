import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHAT_HEALTH_PATH,
	CHAT_PROTOCOL_VERSION,
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
} from "@dg/common";
import {
	createCredentialClient,
	type DgPaths,
	resolveDgPaths,
	writeCredentialGrantToken,
	writePidFileAtomic,
	writeSessionToken,
} from "@dg/common/node";

const sessionId = "fixture-credentials-session";
const token = "fixture-credentials-token";
const grantToken = "fixture-grant-token";
let dgHome: string;
let paths: DgPaths;
let savedToken: string | undefined;

beforeEach(() => {
	dgHome = mkdtempSync(join(tmpdir(), "dg-credentials-client-"));
	paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	savedToken = process.env.DG_SESSION_TOKEN;
	delete process.env.DG_SESSION_TOKEN;
});

afterEach(() => {
	if (savedToken !== undefined) process.env.DG_SESSION_TOKEN = savedToken;
	rmSync(dgHome, { recursive: true, force: true });
});

function fixtureDaemon(store: Map<string, string>) {
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).pathname === CHAT_HEALTH_PATH)
				return Response.json({ instanceId: "fixture-credentials-daemon" });
			const sessionOk =
				request.headers.get(CLI_SESSION_ID_HEADER) === sessionId &&
				request.headers.get(CLI_SESSION_TOKEN_HEADER) === token;
			const grantOk =
				request.headers.get(CLI_GRANT_PREFIX_HEADER) === "consumer" &&
				request.headers.get(CLI_GRANT_TOKEN_HEADER) === grantToken;
			if (!sessionOk && !grantOk)
				return new Response("unauthorized", { status: 401 });
			if (server.upgrade(request)) return;
			return new Response("upgrade required", { status: 400 });
		},
		websocket: {
			message(socket, message) {
				const frame = JSON.parse(String(message)) as Record<string, string> & {
					grant?: unknown;
				};
				requests.push(frame);
				let value: unknown = null;
				if (frame.operation === "set") store.set(frame.name, frame.value);
				if (frame.operation === "get" && store.has(frame.name))
					value = {
						value: store.get(frame.name),
						meta: {},
						updatedAt: "2026-01-01T00:00:00.000Z",
					};
				if (frame.operation === "list")
					value = [...store.keys()].map((name) => ({
						name,
						meta: {},
						updatedAt: "2026-01-01T00:00:00.000Z",
					}));
				if (frame.operation === "delete") value = store.delete(frame.name);
				if (frame.operation === "grant")
					value = { prefix: frame.prefix, path: "/fixture/path" };
				if (frame.operation === "grant-list") value = [];
				socket.send(
					JSON.stringify({
						type: "cli-credentials-result",
						sessionId: frame.grant ? "transport-error" : sessionId,
						requestId: frame.requestId,
						ok: true,
						value,
					}),
				);
			},
		},
	});
	writePidFileAtomic(paths, {
		pid: process.pid,
		port: server.port!,
		instanceId: "fixture-credentials-daemon",
		versions: { package: "1.0.0", protocol: CHAT_PROTOCOL_VERSION },
	});
	writeSessionToken(paths, sessionId, {
		sessionId,
		token,
		cwd: dgHome,
		agentIdentity: "fixture-model",
	});
	return { requests, stop: () => server.stop(true) };
}

describe("createCredentialClient", () => {
	it("sets, gets, lists and deletes over the authenticated CLI socket", async () => {
		const daemon = fixtureDaemon(new Map());
		const client = createCredentialClient({ paths, session: sessionId });
		try {
			await client.set("consumer/example", "fixture-client-value", {
				provider: "example",
			});
			expect((await client.get("consumer/example"))?.value).toBe(
				"fixture-client-value",
			);
			expect(await client.get("consumer/missing")).toBeUndefined();
			expect((await client.list()).map((entry) => entry.name)).toEqual([
				"consumer/example",
			]);
			expect(await client.delete("consumer/example")).toBe(true);
			expect(daemon.requests[0]).toMatchObject({
				type: "cli-credentials-request",
				operation: "set",
				meta: { provider: "example" },
			});
		} finally {
			client.close();
			daemon.stop();
		}
	});

	it("rejects secret-like meta before anything reaches the daemon", async () => {
		const daemon = fixtureDaemon(new Map());
		const client = createCredentialClient({ paths, session: sessionId });
		try {
			await expect(
				client.set("consumer/example", "fixture-value", {
					accessToken: "fixture-value",
				}),
			).rejects.toThrow(/secret/);
			expect(daemon.requests).toEqual([]);
		} finally {
			client.close();
			daemon.stop();
		}
	});

	it("names the start command when no daemon pid file exists", async () => {
		const client = createCredentialClient({ paths, session: sessionId });
		await expect(client.list()).rejects.toThrow(
			"dg-daemon is not running; start it with dg-agent start",
		);
	});

	it("names the start command when the pid file points at a stopped daemon", async () => {
		const daemon = fixtureDaemon(new Map());
		daemon.stop();
		const client = createCredentialClient({ paths, session: sessionId });
		await expect(client.list()).rejects.toThrow(/dg-daemon is not running/);
	});

	it("passes grant, revoke and grant-list through", async () => {
		const daemon = fixtureDaemon(new Map());
		const client = createCredentialClient({ paths, session: sessionId });
		try {
			expect(await client.grant("consumer")).toEqual({
				prefix: "consumer",
				path: "/fixture/path",
			});
			expect(await client.listGrants()).toEqual([]);
			await client.revoke("consumer");
			expect(daemon.requests.map((frame) => frame.operation)).toEqual([
				"grant",
				"grant-list",
				"revoke",
			]);
		} finally {
			client.close();
			daemon.stop();
		}
	});

	describe("with a grant", () => {
		it("reads the token file and authenticates the socket and every frame with it", async () => {
			const daemon = fixtureDaemon(
				new Map([["consumer/example", "fixture-granted"]]),
			);
			writeCredentialGrantToken(paths, "consumer", grantToken);
			const client = createCredentialClient({
				paths,
				grant: { prefix: "consumer" },
			});
			try {
				expect(
					await client.resolveCredential("consumer/example"),
				).toEqual({ value: "fixture-granted", source: "store" });
				expect(daemon.requests[0].grant).toEqual({
					prefix: "consumer",
					token: grantToken,
				});
			} finally {
				client.close();
				daemon.stop();
			}
		});

		it("explains a missing grant file and still falls back to env", async () => {
			const daemon = fixtureDaemon(new Map());
			const client = createCredentialClient({
				paths,
				grant: { prefix: "consumer" },
				env: { EXAMPLE_KEY: "fixture-env" },
			});
			try {
				await expect(client.list()).rejects.toThrow(
					"no credential grant for consumer; run dg-skills credentials grant consumer",
				);
				expect(
					await client.resolveCredential("consumer/example", {
						env: ["EXAMPLE_KEY"],
					}),
				).toMatchObject({ source: "env", envName: "EXAMPLE_KEY" });
			} finally {
				client.close();
				daemon.stop();
			}
		});

		it("names a refused grant when the daemon is live", async () => {
			const daemon = fixtureDaemon(new Map());
			writeCredentialGrantToken(paths, "consumer", "stale-fixture-token");
			const client = createCredentialClient({
				paths,
				grant: { prefix: "consumer" },
			});
			try {
				await expect(client.list()).rejects.toThrow(/refused the credential grant/);
			} finally {
				client.close();
				daemon.stop();
			}
		});
	});

	describe("resolveCredential", () => {
		it("prefers the store and reports the source", async () => {
			const daemon = fixtureDaemon(
				new Map([["consumer/example", "fixture-stored"]]),
			);
			const client = createCredentialClient({
				paths,
				session: sessionId,
				env: { EXAMPLE_KEY: "fixture-env" },
			});
			try {
				expect(
					await client.resolveCredential("consumer/example", {
						env: ["EXAMPLE_KEY"],
					}),
				).toEqual({ value: "fixture-stored", source: "store" });
			} finally {
				client.close();
				daemon.stop();
			}
		});

		it("falls back to the first non-empty env var on a store miss", async () => {
			const daemon = fixtureDaemon(new Map());
			const client = createCredentialClient({
				paths,
				session: sessionId,
				env: { EMPTY_KEY: "", EXAMPLE_KEY: "fixture-env" },
			});
			try {
				expect(
					await client.resolveCredential("consumer/example", {
						env: ["MISSING_KEY", "EMPTY_KEY", "EXAMPLE_KEY"],
					}),
				).toEqual({
					value: "fixture-env",
					source: "env",
					envName: "EXAMPLE_KEY",
				});
				expect(
					await client.resolveCredential("consumer/example"),
				).toBeUndefined();
			} finally {
				client.close();
				daemon.stop();
			}
		});

		it("uses env when the daemon is not running, and surfaces the error otherwise", async () => {
			const withEnv = createCredentialClient({
				paths,
				session: sessionId,
				env: { EXAMPLE_KEY: "fixture-env" },
			});
			expect(
				await withEnv.resolveCredential("consumer/example", {
					env: ["EXAMPLE_KEY"],
				}),
			).toMatchObject({ source: "env" });
			const withoutEnv = createCredentialClient({
				paths,
				session: sessionId,
				env: {},
			});
			await expect(
				withoutEnv.resolveCredential("consumer/example", {
					env: ["EXAMPLE_KEY"],
				}),
			).rejects.toThrow(/dg-daemon is not running/);
		});
	});
});
