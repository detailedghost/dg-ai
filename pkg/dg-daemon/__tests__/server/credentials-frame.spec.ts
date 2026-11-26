import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLI_GRANT_PREFIX_HEADER, CLI_GRANT_TOKEN_HEADER } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	cleanupDgHome,
	cliSocket,
	closeSockets,
	collectFrames,
	connectCli,
	frameType,
	killDaemonByPidFile,
	readDaemonLog,
	removeScratchDirs,
	credentialRequest as request,
	credentialResult as result,
	scanFileForBytes,
	send,
	startWithSession,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

const NOT_ALLOWED = "Credential request not allowed for this caller.";
const sockets: WebSocket[] = [];

type BunWebSocketCtor = new (
	url: string,
	options?: { headers?: Record<string, string> },
) => WebSocket;

async function grantSocket(port: number, prefix: string, token: string) {
	const socket = new (WebSocket as unknown as BunWebSocketCtor)(
		`ws://127.0.0.1:${port}/cli`,
		{
			headers: {
				[CLI_GRANT_PREFIX_HEADER]: prefix,
				[CLI_GRANT_TOKEN_HEADER]: token,
			},
		},
	);
	sockets.push(socket);
	await waitForOpen(socket);
	return socket;
}
let dgHome: string | undefined;

afterEach(() => {
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
	return { ...started, cli, results: collectFrames(cli) };
}

describe("daemon credentials frame", () => {
	it("sets, gets, lists and deletes over the authenticated CLI socket without logging the value", async () => {
		const { cli, results, bootstrap } = await boot();
		const value = "fixture-frame-credential-4e8a1c";
		const meta = { provider: "example", expiresAt: "2030-01-01T00:00:00Z" };
		const setId = request(cli, {
			operation: "set",
			name: "consumer/example",
			value,
			meta,
		});
		expect(await result(results, setId)).toMatchObject({
			ok: true,
			sessionId: bootstrap.sessionId,
		});
		const getId = request(cli, { operation: "get", name: "consumer/example" });
		expect((await result(results, getId)).value).toMatchObject({ value, meta });
		const missingId = request(cli, {
			operation: "get",
			name: "consumer/missing",
		});
		expect((await result(results, missingId)).value).toBeNull();
		const listId = request(cli, { operation: "list" });
		const list = await result(results, listId);
		expect(list.value).toEqual([
			expect.objectContaining({ name: "consumer/example", meta }),
		]);
		expect(JSON.stringify(list)).not.toContain(value);
		const deleteId = request(cli, {
			operation: "delete",
			name: "consumer/example",
		});
		expect((await result(results, deleteId)).value).toBe(true);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome! } });
		expect(readDaemonLog(dgHome!)).not.toContain(value);
		expect(scanFileForBytes(paths.dbPath, value)).toBe(false);
	});

	it("answers an invalid request with an error that does not echo the value", async () => {
		const { cli, results } = await boot();
		const value = "fixture-rejected-credential-a91d07";
		const requestId = request(cli, {
			operation: "set",
			name: "consumer/example",
			value,
			meta: { apiToken: value },
		});
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/secret/);
		expect(JSON.stringify(answer)).not.toContain(value);
		expect(readDaemonLog(dgHome!)).not.toContain(value);
	});

	it("refuses a CLI upgrade with a wrong session token", async () => {
		const { port, bootstrap } = await boot();
		const socket = cliSocket(port, {
			sessionId: bootstrap.sessionId,
			token: "rejected-fixture-token",
		});
		sockets.push(socket);
		await expect(waitForOpen(socket)).rejects.toThrow();
	});

	it("refuses every operation on an unauthenticated extension socket", async () => {
		const { port } = await boot();
		const page = wsExtensionSocket(port);
		sockets.push(page);
		const frames = collectFrames(page);
		await waitForOpen(page);
		const requestId = request(page, { operation: "list" });
		const answer = await result(frames, requestId);
		expect(answer).toMatchObject({ ok: false, error: NOT_ALLOWED });
	});

	it("lets an authenticated extension get and list only under extension/", async () => {
		const { cli, results, port, bootstrap } = await boot();
		for (const name of ["extension/example", "consumer/example"])
			expect(
				(
					await result(
						results,
						request(cli, {
							operation: "set",
							name,
							value: `fixture-${name}`,
							meta: {},
						}),
					)
				).ok,
			).toBe(true);
		const page = wsExtensionSocket(port);
		sockets.push(page);
		const frames = collectFrames(page);
		await waitForOpen(page);
		send(page, { type: "connect", ...bootstrap, extensionVersion: "1.11.0" });
		await waitForValue(
			() => frames.find((frame) => frameType(frame) === "session-list"),
			2000,
			"extension handshake",
		);
		const list = await result(frames, request(page, { operation: "list" }));
		expect(
			(list.value as { name: string }[]).map((entry) => entry.name),
		).toEqual(["extension/example"]);
		expect(
			(
				await result(
					frames,
					request(page, { operation: "get", name: "extension/example" }),
				)
			).value,
		).toMatchObject({ value: "fixture-extension/example" });
		for (const fields of [
			{ operation: "get", name: "consumer/example" },
			{ operation: "get", name: "extensionx/example" },
			{ operation: "set", name: "extension/new", value: "fixture", meta: {} },
			{ operation: "delete", name: "extension/example" },
			{ operation: "grant", prefix: "extension" },
		])
			expect(await result(frames, request(page, fields))).toMatchObject({
				ok: false,
				error: NOT_ALLOWED,
			});
	});
});

describe("daemon credential grants", () => {
	it("grants a 0600 token file, serves get and list under the prefix only, rotates and revokes", async () => {
		const { cli, results, port } = await boot();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome! } });
		const value = "fixture-granted-value-77d2a1";
		for (const name of [
			"channel-review/datadog",
			"channel-review-other/datadog",
			"other/datadog",
		])
			await result(
				results,
				request(cli, { operation: "set", name, value, meta: {} }),
			);
		const granted = await result(
			results,
			request(cli, { operation: "grant", prefix: "channel-review" }),
		);
		const tokenPath = join(paths.grantsDir, "channel-review.token");
		expect(granted.value).toEqual({
			prefix: "channel-review",
			path: tokenPath,
		});
		expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
		expect(statSync(paths.grantsDir).mode & 0o777).toBe(0o700);
		const token = readFileSync(tokenPath, "utf8");
		expect(JSON.stringify(granted)).not.toContain(token);

		const service = await grantSocket(port, "channel-review", token);
		const frames = collectFrames(service);
		const grant = { prefix: "channel-review", token };
		const list = await result(
			frames,
			request(service, { operation: "list", grant }),
		);
		expect(
			(list.value as { name: string }[]).map((entry) => entry.name),
		).toEqual(["channel-review/datadog"]);
		expect(
			(
				await result(
					frames,
					request(service, {
						operation: "get",
						name: "channel-review/datadog",
						grant,
					}),
				)
			).value,
		).toMatchObject({ value });
		for (const fields of [
			{ operation: "get", name: "other/datadog" },
			{ operation: "get", name: "channel-review-other/datadog" },
			{ operation: "get", name: "channel-review" },
			{ operation: "set", name: "channel-review/new", value, meta: {} },
			{ operation: "delete", name: "channel-review/datadog" },
			{ operation: "grant-list" },
		])
			expect(
				await result(frames, request(service, { ...fields, grant })),
			).toMatchObject({ ok: false, error: NOT_ALLOWED });
		expect(
			await result(
				frames,
				request(service, {
					operation: "get",
					name: "channel-review/datadog",
					grant: { prefix: "channel-review", token: `${token}x` },
				}),
			),
		).toMatchObject({ ok: false, error: NOT_ALLOWED });

		const grants = await result(
			results,
			request(cli, { operation: "grant-list" }),
		);
		expect(grants.value).toEqual([
			expect.objectContaining({ prefix: "channel-review" }),
		]);
		expect(
			(grants.value as { lastUsedAt: string | null }[])[0].lastUsedAt,
		).not.toBeNull();
		expect(JSON.stringify(grants)).not.toContain(token);

		await result(
			results,
			request(cli, { operation: "grant", prefix: "channel-review" }),
		);
		const rotated = readFileSync(tokenPath, "utf8");
		expect(rotated).not.toBe(token);
		expect(
			await result(frames, request(service, { operation: "list", grant })),
		).toMatchObject({ ok: false, error: NOT_ALLOWED });

		const revoked = await result(
			results,
			request(cli, { operation: "revoke", prefix: "channel-review" }),
		);
		expect(revoked.value).toBe(true);
		expect(existsSync(tokenPath)).toBe(false);
		const log = readDaemonLog(dgHome!);
		for (const secret of [token, rotated, value])
			expect(log).not.toContain(secret);
	});

	it("refuses a CLI upgrade with a wrong grant token", async () => {
		const { cli, results, port } = await boot();
		await result(
			results,
			request(cli, { operation: "grant", prefix: "channel-review" }),
		);
		await expect(
			grantSocket(port, "channel-review", "wrong-fixture-token"),
		).rejects.toThrow();
	});
});

describe("daemon plugin approval operations", () => {
	const KEY = "dg/plugin-approval-key";
	const fields = ["demo", "skill", "https://example.org/demo.git", "commit", "0123", "aa", "aa"];
	const SEALED = /never|sealed|not allowed/i;

	it("signs and verifies for a session, creates the key on first sign, and never returns the key", async () => {
		const { cli, results } = await boot();
		const missing = await result(results, request(cli, { operation: "approval-verify", purpose: "approval", fields, mac: "a".repeat(64) }));
		expect(missing).toMatchObject({ ok: true, value: false });
		expect((await result(results, request(cli, { operation: "list" }))).value).toEqual([]);

		const signed = await result(results, request(cli, { operation: "approval-sign", purpose: "approval", fields }));
		expect(signed.ok).toBe(true);
		const mac = signed.value as string;
		expect(mac).toMatch(/^[0-9a-f]{64}$/);
		const again = await result(results, request(cli, { operation: "approval-sign", purpose: "approval", fields }));
		expect(again.value).toBe(mac);
		expect((await result(results, request(cli, { operation: "approval-verify", purpose: "approval", fields, mac }))).value).toBe(true);
		expect((await result(results, request(cli, { operation: "approval-verify", purpose: "approval", fields: fields.with(0, "x"), mac }))).value).toBe(false);

		const listed = await result(results, request(cli, { operation: "list" }));
		expect(listed.value).toEqual([expect.objectContaining({ name: KEY })]);
		expect(Object.keys((listed.value as object[])[0]).sort()).toEqual(["meta", "name", "updatedAt"]);
	});

	it("refuses get, set, intake and exec of the key for a session", async () => {
		const { cli, results } = await boot();
		await result(results, request(cli, { operation: "approval-sign", purpose: "approval", fields }));
		for (const body of [
			{ operation: "get", name: KEY },
			{ operation: "get", name: KEY.toUpperCase() },
			{ operation: "set", name: KEY, value: "f".repeat(64), meta: {} },
			{ operation: "intake", name: KEY, meta: {} },
			{ operation: "exec", exec: { bindings: [{ name: KEY, env: "K" }], argv: ["/bin/true"], cwd: "/tmp", env: {} } },
		]) {
			const answer = await result(results, request(cli, body));
			expect([body.operation, answer.ok, answer.error]).toEqual([body.operation, false, expect.stringMatching(SEALED)]);
		}
		const verify = await result(results, request(cli, { operation: "approval-verify", purpose: "approval", fields, mac: "0".repeat(64) }));
		expect(verify.value).toBe(false);
	});

	it("signs and verifies the statcache purpose for a session", async () => {
		const { cli, results } = await boot();
		const three = ["tree", "1700000000000", "digest"];
		const signed = await result(results, request(cli, { operation: "approval-sign", purpose: "statcache", fields: three }));
		expect(signed.ok).toBe(true);
		const ok = await result(results, request(cli, { operation: "approval-verify", purpose: "statcache", fields: three, mac: signed.value }));
		expect(ok.value).toBe(true);
	});

	it("refuses a prefix grant and the extension for both operations", async () => {
		const { cli, results, port, bootstrap } = await boot();
		await result(results, request(cli, { operation: "approval-sign", purpose: "approval", fields }));
		await result(results, request(cli, { operation: "grant", prefix: "dg" }));
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome! } });
		const token = readFileSync(join(paths.grantsDir, "dg.token"), "utf8");
		const service = await grantSocket(port, "dg", token);
		const frames = collectFrames(service);
		const grant = { prefix: "dg", token };
		for (const body of [
			{ operation: "approval-sign", purpose: "approval", fields },
			{ operation: "approval-verify", purpose: "approval", fields, mac: "0".repeat(64) },
			{ operation: "get", name: KEY },
		])
			expect(await result(frames, request(service, { ...body, grant }))).toMatchObject({ ok: false });
		const page = wsExtensionSocket(port);
		sockets.push(page);
		const pageFrames = collectFrames(page);
		await waitForOpen(page);
		send(page, { type: "connect", ...bootstrap, extensionVersion: "1.11.0" });
		await waitForValue(() => pageFrames.find((frame) => frameType(frame) === "session-list"), 2000, "extension handshake");
		expect(await result(pageFrames, request(page, { operation: "approval-sign", purpose: "approval", fields }))).toMatchObject({ ok: false, error: NOT_ALLOWED });
	});

	it("answers a field with a NUL byte as an error", async () => {
		const { cli, results } = await boot();
		const answer = await result(results, request(cli, { operation: "approval-sign", purpose: "approval", fields: fields.with(2, "a\u0000b") }));
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/NUL/);
	});
});
