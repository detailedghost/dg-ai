import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
	CREDENTIAL_MAX_VALUE_BYTES,
	jobCredentialsPath,
	OWNER_TOKEN_HEADER,
	SERVICE_API_CREDENTIALS_PATH,
} from "@dg/common";
import {
	credentialGrantTokenPath,
	type DgPaths,
	resolveDgPaths,
} from "@dg/common/node";
import type { ParsedJob } from "../../src/jobs/config";
import { STORAGE_FAILED } from "../../src/server/capped-body";
import { handleJobCredentials } from "../../src/server/job-credentials";
import { CredentialStore } from "../../src/store/credentials-store";
import { ChatStore } from "../../src/store";
import {
	bootServe,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	killDaemonByPidFile,
	ownerTokenHeader,
	readDaemonLog,
	removeScratchDirs,
	stopServe,
} from "../utils/daemon-harness";

const VALUE = "fixture-value-job-route-8c41";
const NOT_ALLOWED = "Credential request not allowed for this caller.";

type Boot = Awaited<ReturnType<typeof bootServe>>;
let daemon: Boot;
let paths: DgPaths;
const seen: string[] = [];

type Call = {
	job?: string;
	body?: unknown;
	rawBody?: string;
	method?: string;
	headers?: Record<string, string | null>;
};

function jobsConfig(extra: Record<string, unknown> = {}) {
	const entry = (grant?: string) => ({
		argv: [process.execPath, "-e", "0"],
		cwd: daemon.dgHome,
		continuous: true,
		...(grant === undefined ? {} : { grant }),
	});
	return {
		jobs: {
			a: entry("a"),
			b: entry("b"),
			bot: entry("bot"),
			first: entry("tools"),
			second: entry("tools"),
			reserved: entry("pw"),
			bare: entry(),
			broken: { ...entry("a"), argv: [] },
			...extra,
		},
	};
}

function writeJobs(extra: Record<string, unknown> = {}): void {
	writeFileSync(paths.daemonConfigPath, JSON.stringify(jobsConfig(extra)));
}

async function post(call: Call = {}): Promise<Response> {
	const job = call.job ?? "a";
	const headers: Record<string, string | null> = {
		...ownerTokenHeader(daemon.port),
		"Content-Type": "application/json",
		...call.headers,
	};
	const sent = Object.fromEntries(
		Object.entries(headers).filter(([, v]) => v !== null),
	) as Record<string, string>;
	const method = call.method ?? "POST";
	const response = await fetch(
		`http://127.0.0.1:${daemon.port}${jobCredentialsPath(job)}`,
		{
			method,
			headers: sent,
			...(method === "POST"
				? { body: call.rawBody ?? JSON.stringify(call.body ?? { operation: "status" }) }
				: {}),
		},
	);
	seen.push(await response.clone().text());
	return response;
}

async function op(job: string, body: Record<string, unknown>) {
	const response = await post({ job, body });
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const tokenFile = (prefix: string) => credentialGrantTokenPath(paths, prefix);
const readToken = (prefix: string) => readFileSync(tokenFile(prefix), "utf8").trim();

async function serviceGet(prefix: string, token: string, name: string) {
	const response = await fetch(`http://127.0.0.1:${daemon.port}${SERVICE_API_CREDENTIALS_PATH}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			[CLI_GRANT_PREFIX_HEADER]: prefix,
			[CLI_GRANT_TOKEN_HEADER]: token,
		},
		body: JSON.stringify({ operation: "get", name }),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
	daemon = await bootServe();
	paths = resolveDgPaths({ env: { DG_HOME: daemon.dgHome } });
	writeJobs();
});

afterAll(async () => {
	await stopServe(daemon.proc);
	killDaemonByPidFile(daemon.dgHome);
	cleanupDgHome(daemon.dgHome);
	removeScratchDirs();
});

function expectRefusal(body: Record<string, unknown>, error: string | RegExp) {
	expect(body.ok).toBe(false);
	if (typeof error === "string") expect(body.error).toBe(error);
	else expect(String(body.error)).toMatch(error);
}

describe("POST /jobs/<name>/credentials guards", () => {
	it("answers 401 with no owner token and with a wrong one", async () => {
		for (const headers of [
			{ [OWNER_TOKEN_HEADER]: null },
			{ [OWNER_TOKEN_HEADER]: "wrong-owner-token" },
		]) {
			const response = await post({ headers });
			expect(response.status).toBe(401);
			expectRefusal((await response.json()) as Record<string, unknown>, /./);
		}
	});

	it("answers 400 for any Origin header, with or without the owner token", async () => {
		for (const origin of ["https://evil.example", "chrome-extension://abcdefghijklmnopabcdefghijklmnop"]) {
			const withToken = await post({ headers: { Origin: origin } });
			expect(withToken.status).toBe(400);
			expectRefusal((await withToken.json()) as Record<string, unknown>, /Origin/);
			const noToken = await post({ headers: { Origin: origin, [OWNER_TOKEN_HEADER]: null } });
			expect(noToken.status).toBe(400);
		}
	});

	it("answers 400 for a Host that is not the loopback authority", async () => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}${jobCredentialsPath("a")}`, {
			method: "POST",
			headers: { ...ownerTokenHeader(daemon.port), Host: "evil.example", "Content-Type": "application/json" },
			body: JSON.stringify({ operation: "status" }),
		});
		expect(response.status).toBe(400);
	});

	it("answers 404 for a method other than POST", async () => {
		for (const method of ["GET", "PUT", "DELETE"]) {
			const response = await post({ method });
			expect(response.status).toBe(404);
		}
	});

	it("answers 404 with the job error for an unknown job", async () => {
		const response = await post({ job: "nobody" });
		expect(response.status).toBe(404);
		expectRefusal((await response.json()) as Record<string, unknown>, 'no job named "nobody"');
	});

	it("answers 409 for a job with no credential prefix", async () => {
		const response = await post({ job: "bare" });
		expect(response.status).toBe(409);
		expectRefusal((await response.json()) as Record<string, unknown>, 'job "bare" has no credential prefix');
	});

	it("answers 409 with the entry error for an invalid job entry", async () => {
		const response = await post({ job: "broken" });
		expect(response.status).toBe(409);
		const body = (await response.json()) as Record<string, unknown>;
		expectRefusal(body, /^job "broken" is not valid: /);
		expect(String(body.error)).not.toContain("no credential prefix");
	});

	it("answers 400 with JSON for a malformed percent-encoded job name", async () => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}/jobs/%zz/credentials`, {
			method: "POST",
			headers: { ...ownerTokenHeader(daemon.port), "Content-Type": "application/json" },
			body: JSON.stringify({ operation: "status" }),
		});
		expect(response.status).toBe(400);
		expectRefusal((await response.json()) as Record<string, unknown>, "malformed job name");
	});

	it("answers 403 for a job whose prefix is reserved, for each operation", async () => {
		for (const body of [
			{ operation: "status" },
			{ operation: "ensure-grant" },
			{ operation: "rotate-grant" },
			{ operation: "set", name: "pw/x", value: VALUE, meta: {} },
		]) {
			const result = await op("reserved", body);
			expect(result.status).toBe(403);
			expect(result.body.ok).toBe(false);
		}
	});

	it("answers 415 for another content type", async () => {
		const response = await post({ headers: { "Content-Type": "text/plain" } });
		expect(response.status).toBe(415);
		expect(((await response.json()) as Record<string, unknown>).ok).toBe(false);
	});

	it("answers 413 above 128 KiB and 400 for a body that is not a JSON object", async () => {
		const big = await post({ rawBody: JSON.stringify({ operation: "status", pad: "x".repeat(131_072) }) });
		expect(big.status).toBe(413);
		expect(((await big.json()) as Record<string, unknown>).ok).toBe(false);
		for (const rawBody of ["not json", "[1]", "null"]) {
			const response = await post({ rawBody });
			expect(response.status).toBe(400);
			expect(((await response.json()) as Record<string, unknown>).ok).toBe(false);
		}
	});

	it("answers 400 for an unknown operation, a missing operation, an extra key and a name that is not a string", async () => {
		const cases: Record<string, unknown>[] = [
			{ operation: "list" },
			{ operation: "frobnicate" },
			{},
			{ operation: 7 },
			{ operation: "status", extra: true },
			{ operation: "ensure-grant", name: "a/x" },
			{ operation: "set", name: "a/x", value: VALUE, meta: {}, prefix: "b" },
			{ operation: "delete", name: 7 },
			{ operation: "set", name: ["a/x"], value: VALUE },
			{ operation: "delete" },
		];
		for (const body of cases) {
			const result = await op("a", body);
			expect(result.status).toBe(400);
			expect(result.body.ok).toBe(false);
		}
	});

	it("answers 403 for get and for any other operation that would read a value", async () => {
		const result = await op("a", { operation: "get", name: "a/x" });
		expect(result.status).toBe(403);
		expectRefusal(result.body, NOT_ALLOWED);
	});
});

describe("credential names and the prefix", () => {
	it("answers 403 for a name outside the prefix and stores nothing", async () => {
		const set = await op("a", { operation: "set", name: "b/x", value: VALUE, meta: {} });
		expect(set.status).toBe(403);
		expectRefusal(set.body, NOT_ALLOWED);
		const status = await op("b", { operation: "status" });
		expect((status.body.credentials as unknown[]).length).toBe(0);
	});

	it("answers 403 for the bare prefix and for a longer prefix", async () => {
		for (const name of ["a", "ab/x", "b/a/x"]) {
			expect((await op("a", { operation: "set", name, value: VALUE, meta: {} })).status).toBe(403);
			expect((await op("a", { operation: "delete", name })).status).toBe(403);
		}
	});

	it("folds the letter case of a name below the prefix", async () => {
		const set = await op("a", { operation: "set", name: "A/Fold", value: VALUE, meta: {} });
		expect(set.status).toBe(200);
		const status = await op("a", { operation: "status" });
		expect((status.body.credentials as { name: string }[]).map((c) => c.name)).toContain("a/fold");
		expect((await op("a", { operation: "delete", name: "a/fold" })).body.deleted).toBe(true);
	});

	it("answers 400 and does not echo the value for an invalid name, value or meta", async () => {
		const cases = [
			{ operation: "set", name: "a/has space", value: VALUE, meta: {} },
			{ operation: "set", name: "a/x", value: "", meta: {} },
			{ operation: "set", name: "a/x", value: 5, meta: {} },
			{ operation: "set", name: "a/x", value: VALUE, meta: { password: "p" } },
			{ operation: "set", name: "a/x", value: VALUE, meta: [] },
			{ operation: "set", name: "a/x", meta: {} },
		];
		for (const body of cases) {
			const response = await post({ job: "a", body });
			expect(response.status).toBe(400);
			const text = await response.text();
			expect(text).not.toContain(VALUE);
			expect((JSON.parse(text) as Record<string, unknown>).ok).toBe(false);
		}
		const status = await op("a", { operation: "status" });
		expect(status.body.credentials).toEqual([]);
	});

	it("accepts a set with no meta", async () => {
		expect((await op("a", { operation: "set", name: "a/nometa", value: VALUE })).status).toBe(200);
		const status = await op("a", { operation: "status" });
		expect((status.body.credentials as { meta: unknown }[])[0]?.meta).toEqual({});
		await op("a", { operation: "delete", name: "a/nometa" });
	});

	it("deletes a name that exists and reports one that does not", async () => {
		await op("a", { operation: "set", name: "a/gone", value: VALUE, meta: {} });
		const first = await op("a", { operation: "delete", name: "a/gone" });
		expect(first).toEqual({ status: 200, body: { deleted: true } });
		const second = await op("a", { operation: "delete", name: "a/gone" });
		expect(second).toEqual({ status: 200, body: { deleted: false } });
	});

	it("accepts a plain value of 65536 bytes and refuses a value that JSON escapes push above 128 KiB", async () => {
		const plain = await op("a", {
			operation: "set",
			name: "a/big",
			value: "v".repeat(CREDENTIAL_MAX_VALUE_BYTES),
			meta: {},
		});
		expect(plain.status).toBe(200);
		const escaped = await post({
			job: "a",
			body: { operation: "set", name: "a/big2", value: '"'.repeat(CREDENTIAL_MAX_VALUE_BYTES), meta: {} },
		});
		expect(escaped.status).toBe(413);
		await op("a", { operation: "delete", name: "a/big" });
	});
});

describe("status", () => {
	it("lists only the names below the prefix, with meta and updatedAt and no value", async () => {
		await op("a", { operation: "set", name: "a/one", value: VALUE, meta: { note: "n" } });
		await op("b", { operation: "set", name: "b/two", value: VALUE, meta: {} });
		const result = await op("a", { operation: "status" });
		expect(result.status).toBe(200);
		expect(result.body.prefix).toBe("a");
		const credentials = result.body.credentials as Record<string, unknown>[];
		expect(credentials.map((c) => c.name)).toEqual(["a/one"]);
		expect(Object.keys(credentials[0] ?? {}).sort()).toEqual(["meta", "name", "updatedAt"]);
		expect(credentials[0]?.meta).toEqual({ note: "n" });
		expect(JSON.stringify(result.body)).not.toContain(VALUE);
		await op("a", { operation: "delete", name: "a/one" });
		await op("b", { operation: "delete", name: "b/two" });
	});

	it("reports missing, ok and stale for the grant", async () => {
		expect((await op("bot", { operation: "status" })).body.grant).toBe("missing");
		await op("bot", { operation: "ensure-grant" });
		expect((await op("bot", { operation: "status" })).body.grant).toBe("ok");
		rmSync(tokenFile("bot"));
		expect((await op("bot", { operation: "status" })).body.grant).toBe("stale");
		await op("bot", { operation: "ensure-grant" });
		writeFileSync(tokenFile("bot"), "not-the-token", { mode: 0o600 });
		expect((await op("bot", { operation: "status" })).body.grant).toBe("stale");
	});

	it("does not write last_used_at", async () => {
		await op("b", { operation: "ensure-grant" });
		await op("b", { operation: "status" });
		await op("b", { operation: "ensure-grant" });
		const ids = await listGrants();
		expect(ids.find((g) => g.prefix === "b")?.lastUsedAt).toBeNull();
	});
});

async function listGrants(): Promise<{ prefix: string; lastUsedAt: string | null }[]> {
	const chat = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	try {
		const store = await CredentialStore.open(paths, chat.cryptoMeta(), FILE_ONLY_SEAMS);
		try {
			return store.listCredentialGrants();
		} finally {
			store.close();
		}
	} finally {
		chat.close();
	}
}

describe("grants", () => {
	it("keeps the same token when ensure-grant runs two times", async () => {
		const first = await op("first", { operation: "ensure-grant" });
		expect(first.body.created).toBe(true);
		expect(first.body.path).toBe(tokenFile("tools"));
		const bytes = readFileSync(tokenFile("tools"));
		const second = await op("first", { operation: "ensure-grant" });
		expect(second.body.created).toBe(false);
		expect(readFileSync(tokenFile("tools")).equals(bytes)).toBe(true);
	});

	it("keeps the token of the first job when a second job with the same prefix gets its grant", async () => {
		const token = readToken("tools");
		const second = await op("second", { operation: "ensure-grant" });
		expect(second.body.created).toBe(false);
		await op("first", { operation: "set", name: "tools/k", value: VALUE, meta: {} });
		const read = await serviceGet("tools", token, "tools/k");
		expect(read.status).toBe(200);
		await op("first", { operation: "delete", name: "tools/k" });
	});

	it("makes a new grant after the token file is deleted", async () => {
		rmSync(tokenFile("tools"));
		const again = await op("first", { operation: "ensure-grant" });
		expect(again.body.created).toBe(true);
		expect((await op("first", { operation: "status" })).body.grant).toBe("ok");
	});

	it("repairs a row that has a new token and a file with the old one", async () => {
		const old = readFileSync(tokenFile("tools"));
		await op("first", { operation: "rotate-grant" });
		writeFileSync(tokenFile("tools"), old, { mode: 0o600 });
		expect((await op("first", { operation: "status" })).body.grant).toBe("stale");
		const repaired = await op("first", { operation: "ensure-grant" });
		expect(repaired.body.created).toBe(true);
		expect((await op("first", { operation: "status" })).body.grant).toBe("ok");
	});

	it("gives exactly one created true for two ensure-grant calls at the same time", async () => {
		rmSync(tokenFile("tools"), { force: true });
		const [x, y] = await Promise.all([
			op("first", { operation: "ensure-grant" }),
			op("second", { operation: "ensure-grant" }),
		]);
		expect([x.body.created, y.body.created].sort()).toEqual([false, true]);
		expect((await op("first", { operation: "status" })).body.grant).toBe("ok");
		await op("first", { operation: "set", name: "tools/c", value: VALUE, meta: {} });
		expect((await serviceGet("tools", readToken("tools"), "tools/c")).status).toBe(200);
		await op("first", { operation: "delete", name: "tools/c" });
	});

	it("rotates the token, ends the old one and writes the file with mode 0600", async () => {
		await op("first", { operation: "set", name: "tools/r", value: VALUE, meta: {} });
		const old = readToken("tools");
		const rotated = await op("first", { operation: "rotate-grant" });
		expect(rotated.status).toBe(200);
		expect(rotated.body.path).toBe(tokenFile("tools"));
		const fresh = readToken("tools");
		expect(fresh).not.toBe(old);
		expect((await serviceGet("tools", old, "tools/r")).status).toBe(401);
		expect((await serviceGet("tools", fresh, "tools/r")).status).toBe(200);
		if (process.platform !== "win32")
			expect(statSync(tokenFile("tools")).mode & 0o777).toBe(0o600);
		await op("first", { operation: "delete", name: "tools/r" });
	});
});

describe("end to end with no agent session", () => {
	it("lets a job read with its grant what the CLI stored", async () => {
		await op("a", { operation: "set", name: "a/e2e", value: VALUE, meta: { note: "n" } });
		await op("a", { operation: "ensure-grant" });
		const read = await serviceGet("a", readToken("a"), "a/e2e");
		expect(read.status).toBe(200);
		expect(read.body).toMatchObject({ ok: true, value: { value: VALUE, meta: { note: "n" } } });
		await op("a", { operation: "delete", name: "a/e2e" });
	});

	it("finds a job that is added to the config while the daemon runs", async () => {
		expect((await post({ job: "late" })).status).toBe(404);
		writeJobs({ late: { argv: [process.execPath, "-e", "0"], cwd: daemon.dgHome, continuous: true, grant: "late" } });
		const response = await post({ job: "late" });
		expect(response.status).toBe(200);
		expect(((await response.json()) as Record<string, unknown>).prefix).toBe("late");
	});

	it("holds no value text and no token in a response or in the daemon log", async () => {
		const log = readDaemonLog(daemon.dgHome);
		expect(log).not.toContain(VALUE);
		for (const text of seen) expect(text).not.toContain(VALUE);
		for (const prefix of ["a", "b", "bot", "tools"]) {
			const token = readToken(prefix);
			expect(log).not.toContain(token);
			for (const text of seen) expect(text).not.toContain(token);
		}
		expect(seen.length).toBeGreaterThan(10);
	});
});

describe("with the credential store closed", () => {
	it("answers 500 with the text of the service API for each operation", async () => {
		const dgHome = freshDgHome();
		const home = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const chat = await ChatStore.open(home, FILE_ONLY_SEAMS);
		const store = await CredentialStore.open(home, chat.cryptoMeta(), FILE_ONLY_SEAMS);
		store.close();
		const errors: string[] = [];
		const job: ParsedJob = {
			ok: true,
			name: "a",
			mode: "continuous",
			argv: ["x"],
			cwd: dgHome,
			enabled: false,
			feed: false,
			credentials: [],
			credentialEnv: {},
			passEnv: [],
			stopTimeoutMs: 1000,
			grant: "a",
		};
		const bodies = [
			{ operation: "status" },
			{ operation: "set", name: "a/x", value: VALUE, meta: {} },
			{ operation: "delete", name: "a/x" },
			{ operation: "ensure-grant" },
			{ operation: "rotate-grant" },
		];
		try {
			for (const body of bodies) {
				const response = await handleJobCredentials(
					new Request("http://127.0.0.1:1/jobs/a/credentials", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
					"a",
					{
						paths: home,
						store,
						readJobs: () => [job],
						isOwner: () => true,
						logger: { error: (line: string) => errors.push(line) },
					},
				);
				expect(response.status).toBe(500);
				const text = await response.text();
				expect(JSON.parse(text)).toEqual({ ok: false, error: STORAGE_FAILED });
				expect(text).not.toContain(VALUE);
			}
			expect(errors.length).toBe(bodies.length);
			for (const line of errors) expect(line).not.toContain(VALUE);
		} finally {
			chat.close();
			cleanupDgHome(dgHome);
		}
	});
});

describe("with a broken jobs table or token folder", () => {
	const job: ParsedJob = {
		ok: true,
		name: "a",
		mode: "continuous",
		argv: ["x"],
		cwd: "/",
		enabled: false,
		feed: false,
		credentials: [],
		credentialEnv: {},
		passEnv: [],
		stopTimeoutMs: 1000,
		grant: "a",
	};

	async function withStore(
		run: (ctx: { home: DgPaths; store: CredentialStore }) => Promise<void>,
	) {
		const dgHome = freshDgHome();
		const home = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const chat = await ChatStore.open(home, FILE_ONLY_SEAMS);
		const store = await CredentialStore.open(home, chat.cryptoMeta(), FILE_ONLY_SEAMS);
		try {
			await run({ home, store });
		} finally {
			store.close();
			chat.close();
			cleanupDgHome(dgHome);
		}
	}

	const request = (operation: string) =>
		new Request("http://127.0.0.1:1/jobs/a/credentials", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operation }),
		});

	it("answers 500 with a jobs table text and logs the error name only when readJobs fails", async () => {
		await withStore(async ({ home, store }) => {
			const errors: string[] = [];
			const response = await handleJobCredentials(request("status"), "a", {
				paths: home,
				store,
				readJobs: () => {
					throw new SyntaxError(`bad json ${VALUE}`);
				},
				isOwner: () => true,
				logger: { error: (line: string) => errors.push(line) },
			});
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				ok: false,
				error: "could not read the jobs table; check the dg config",
			});
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("SyntaxError");
			expect(errors[0]).not.toContain(VALUE);
		});
	});

	it("leaves the grant row unchanged when the token folder cannot be made", async () => {
		await withStore(async ({ home, store }) => {
			mkdirSync(dirname(home.grantsDir), { recursive: true });
			writeFileSync(home.grantsDir, "not a folder");
			const deps = {
				paths: home,
				store,
				readJobs: () => [job],
				isOwner: () => true,
				logger: { error: () => {} },
			};
			for (const operation of ["ensure-grant", "rotate-grant"]) {
				const response = await handleJobCredentials(request(operation), "a", deps);
				expect(response.status).toBe(500);
				expect(store.inspectCredentialGrant("a", undefined).row).toBe(false);
			}
		});
	});
});
