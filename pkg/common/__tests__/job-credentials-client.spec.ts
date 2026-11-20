import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	DgCliError,
	jobCredentialsPath,
	OWNER_TOKEN_HEADER,
} from "../src/index";
import {
	createJobCredentialClient,
	DaemonNotRunningError,
	type DgPaths,
	ensureOwnerToken,
	resolveDgPaths,
	writePidFileAtomic,
} from "../src/node/index";

const VALUE = "fixture-value-for-the-client-spec";
const OLDER = "this dg-daemon is older than the CLI — run dg daemon restart";
type Seen = {
	path: string;
	method: string;
	host: string | null;
	owner: string | null;
	contentType: string | null;
	body: unknown;
};
type Reply = (seen: Seen) => Response;

let dgHome: string;
let paths: DgPaths;
let owner: string;
const servers: { stop(force: boolean): void }[] = [];

beforeEach(() => {
	dgHome = mkdtempSync(join(tmpdir(), "dg-job-credentials-client-"));
	paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	owner = ensureOwnerToken(paths);
});

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	rmSync(dgHome, { recursive: true, force: true });
});

function fixtureDaemon(reply: Reply) {
	const requests: Seen[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const text = await request.text();
			const seen: Seen = {
				path: new URL(request.url).pathname,
				method: request.method,
				host: request.headers.get("host"),
				owner: request.headers.get(OWNER_TOKEN_HEADER),
				contentType: request.headers.get("content-type"),
				body: text ? JSON.parse(text) : undefined,
			};
			requests.push(seen);
			return reply(seen);
		},
	});
	servers.push(server);
	writePidFileAtomic(paths, {
		pid: process.pid,
		port: server.port as number,
		instanceId: "fixture-job-daemon",
		versions: { package: "1.0.0", protocol: CHAT_PROTOCOL_VERSION },
	});
	return { requests, port: server.port as number };
}

const ok = (body: unknown) => () => Response.json(body);

describe("jobCredentialsPath", () => {
	it("encodes the job name as one path segment", () => {
		expect(jobCredentialsPath("bot")).toBe("/jobs/bot/credentials");
		expect(jobCredentialsPath("a/b")).toBe("/jobs/a%2Fb/credentials");
	});
});

describe("createJobCredentialClient", () => {
	it("sends status with the owner token to the job route", async () => {
		const daemon = fixtureDaemon(
			ok({ prefix: "bot", grant: "ok", credentials: [] }),
		);
		const status = await createJobCredentialClient({ paths, job: "bot" }).status();
		expect(status).toEqual({ prefix: "bot", grant: "ok", credentials: [] });
		expect(daemon.requests).toEqual([
			{
				path: "/jobs/bot/credentials",
				method: "POST",
				host: `127.0.0.1:${daemon.port}`,
				owner,
				contentType: "application/json",
				body: { operation: "status" },
			},
		]);
	});

	it("sends set with the name, the value and the meta", async () => {
		const daemon = fixtureDaemon(ok({ ok: true }));
		const client = createJobCredentialClient({ paths, job: "bot" });
		await client.set("bot/x", VALUE, { note: "n" });
		await client.set("bot/y", VALUE);
		expect(daemon.requests.map((r) => r.body)).toEqual([
			{ operation: "set", name: "bot/x", value: VALUE, meta: { note: "n" } },
			{ operation: "set", name: "bot/y", value: VALUE },
		]);
		expect(daemon.requests.every((r) => r.owner === owner)).toBe(true);
	});

	it("sends delete and returns whether a credential existed", async () => {
		const daemon = fixtureDaemon(ok({ deleted: true }));
		const deleted = await createJobCredentialClient({ paths, job: "bot" }).delete("bot/x");
		expect(deleted).toBe(true);
		expect(daemon.requests[0]?.body).toEqual({ operation: "delete", name: "bot/x" });
	});

	it("sends ensure-grant and rotate-grant and returns the answers", async () => {
		const daemon = fixtureDaemon((seen) =>
			Response.json(
				(seen.body as { operation: string }).operation === "ensure-grant"
					? { created: true, path: "/p/bot.token" }
					: { path: "/p/bot.token" },
			),
		);
		const client = createJobCredentialClient({ paths, job: "bot" });
		expect(await client.ensureGrant()).toEqual({ created: true, path: "/p/bot.token" });
		expect(await client.rotateGrant()).toEqual({ path: "/p/bot.token" });
		expect(daemon.requests.map((r) => r.body)).toEqual([
			{ operation: "ensure-grant" },
			{ operation: "rotate-grant" },
		]);
	});

	it("turns a refusal into a DgCliError with the route error", async () => {
		fixtureDaemon(() =>
			Response.json({ ok: false, error: 'job "bot" has no credential prefix' }, { status: 409 }),
		);
		const failure = await createJobCredentialClient({ paths, job: "bot" })
			.status()
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as Error).message).toBe('job "bot" has no credential prefix');
	});

	it("keeps the unknown job error of a new daemon", async () => {
		fixtureDaemon(() =>
			Response.json({ ok: false, error: 'no job named "bot"' }, { status: 404 }),
		);
		const failure = await createJobCredentialClient({ paths, job: "bot" })
			.status()
			.catch((error: unknown) => error);
		expect((failure as Error).message).toBe('no job named "bot"');
		expect((failure as Error).message).not.toContain("older than the CLI");
	});

	it("names an older daemon when a 404 body is not the route JSON", async () => {
		fixtureDaemon(() => new Response("not found", { status: 404 }));
		const failure = await createJobCredentialClient({ paths, job: "bot" })
			.status()
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as Error).message).toBe(OLDER);
	});

	it("names an older daemon when a 404 JSON body has no error text", async () => {
		fixtureDaemon(() => Response.json({ message: "nope" }, { status: 404 }));
		const failure = await createJobCredentialClient({ paths, job: "bot" })
			.status()
			.catch((error: unknown) => error);
		expect((failure as Error).message).toBe(OLDER);
	});

	it("never puts a token or a value in an error", async () => {
		fixtureDaemon(() => new Response(`boom ${VALUE} ${owner}`, { status: 500 }));
		const client = createJobCredentialClient({ paths, job: "bot" });
		for (const call of [
			() => client.set("bot/x", VALUE),
			() => client.status(),
			() => client.ensureGrant(),
		]) {
			const failure = (await call().catch((error: unknown) => error)) as Error;
			expect(failure).toBeInstanceOf(DgCliError);
			expect(failure.message).not.toContain(VALUE);
			expect(failure.message).not.toContain(owner);
		}
	});

	it("throws DaemonNotRunningError when no daemon pid file exists", async () => {
		const failure = await createJobCredentialClient({ paths, job: "bot" })
			.status()
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DaemonNotRunningError);
	});

	it("throws DaemonNotRunningError when the pid file names a closed port", async () => {
		const daemon = fixtureDaemon(ok({}));
		servers.pop()?.stop(true);
		expect(daemon.port).toBeGreaterThan(0);
		const failure = await createJobCredentialClient({ paths, job: "bot" })
			.status()
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DaemonNotRunningError);
	});

	it("throws when there is no owner token", async () => {
		fixtureDaemon(ok({}));
		rmSync(join(paths.daemonDir, "owner.token"), { force: true });
		const failure = await createJobCredentialClient({ paths, job: "bot" })
			.status()
			.catch((error: unknown) => error);
		expect((failure as Error).message).toContain("No owner token found");
	});
});
