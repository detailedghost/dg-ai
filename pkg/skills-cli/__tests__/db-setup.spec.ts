import { describe, expect, mock, test } from "bun:test";
import type { CredentialMeta } from "@dg/common";
import type { SessionTokenRecord } from "@dg/common/node";
import { createDbSpec, type DbDeps } from "../src/db";
import type { DbCredentialClient } from "../src/db/credentials";
import { ensureCwdSession } from "../src/db/session";

const NO_OPTS = { json: false, help: false };

function sessionRecord(sessionId: string, cwd: string): SessionTokenRecord {
	return { sessionId, token: "fixture-token", cwd, agentIdentity: "agent" };
}

describe("ensureCwdSession", () => {
	const cwd = process.cwd();

	test("returns the sole cwd match without spawning", async () => {
		const spawnAgentStart = mock(async () => "spawned");
		const id = await ensureCwdSession(undefined, {
			env: {},
			cwd: () => cwd,
			listSessions: () => [sessionRecord("s-1", cwd), sessionRecord("s-2", "/elsewhere")],
			spawnAgentStart,
		});
		expect(id).toBe("s-1");
		expect(spawnAgentStart).not.toHaveBeenCalled();
	});

	test("spawns dg-agent start once on zero matches and returns its trimmed output", async () => {
		const spawnAgentStart = mock(async () => "s-new\n");
		const id = await ensureCwdSession(undefined, {
			env: {},
			cwd: () => cwd,
			listSessions: () => [],
			spawnAgentStart,
		});
		expect(id).toBe("s-new");
		expect(spawnAgentStart).toHaveBeenCalledTimes(1);
	});

	test("fails naming --session on two matches", async () => {
		await expect(
			ensureCwdSession(undefined, {
				env: {},
				cwd: () => cwd,
				listSessions: () => [sessionRecord("s-1", cwd), sessionRecord("s-2", cwd)],
				spawnAgentStart: async () => "never",
			}),
		).rejects.toThrow(/--session/);
	});

	test("explicit session wins over DG_SESSION_ID, which wins over matching", async () => {
		const deps = {
			cwd: () => cwd,
			listSessions: () => [sessionRecord("s-1", cwd)],
			spawnAgentStart: async () => "never",
		};
		expect(await ensureCwdSession("flag", { ...deps, env: { DG_SESSION_ID: "env" } })).toBe("flag");
		expect(await ensureCwdSession(undefined, { ...deps, env: { DG_SESSION_ID: "env" } })).toBe("env");
	});
});

function setupHarness(overrides: Partial<DbDeps> = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const set = mock(async (_name: string, _value: string, _meta?: CredentialMeta) => {});
	const credentialClient: DbCredentialClient = {
		get: mock(async () => {
			const [, value, meta] = set.mock.calls.at(-1) ?? [];
			return value === undefined
				? undefined
				: { value, meta: meta ?? {}, updatedAt: "2026-01-01T00:00:00Z" };
		}),
		list: mock(async () => []),
		set,
		close: mock(() => {}),
	};
	const createCredentialClient = mock((_session?: string) => credentialClient);
	const pgTest = mock(async () => "OK: PostgreSQL 16");
	const spec = createDbSpec({
		createCredentialClient,
		ensureSession: async (explicit) => explicit ?? "sess-1",
		pgTest,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		...overrides,
	});
	const setup = spec.subcommands.setup;
	if (!setup) throw new Error("setup missing");
	const run = (args: string[]) => setup.run(args, NO_OPTS);
	return { run, stdout, stderr, set, createCredentialClient, pgTest, credentialClient };
}

const PG_FLAGS = ["pg1", "--engine", "postgresql", "--host", "127.0.0.1", "--port", "5433", "--database", "app", "--user", "ro"];

describe("db setup", () => {
	test("prints one credentials set line with every meta pair and no value", async () => {
		const h = setupHarness();
		const code = await h.run([...PG_FLAGS, "--secret", "command", "--session", "sess-9"]);
		expect(code ?? 0).toBe(0);
		const line = h.stdout.find((l) => l.startsWith("dg-skills credentials"));
		expect(line).toBe(
			"dg-skills credentials --session sess-9 set db/pg1 --meta engine=postgresql --meta host=127.0.0.1 --meta port=5433 --meta database=app --meta user=ro --meta readOnly=true",
		);
		expect(h.stdout.filter((l) => l.startsWith("dg-skills credentials"))).toHaveLength(1);
		expect(h.stdout.filter((l) => l.startsWith("Next:"))).toEqual(["Next: dg-skills db test pg1"]);
		expect(h.set).not.toHaveBeenCalled();
		expect(h.pgTest).not.toHaveBeenCalled();
	});

	test("--no-read-only writes readOnly=false", async () => {
		const h = setupHarness();
		await h.run([...PG_FLAGS, "--secret", "command", "--no-read-only"]);
		expect(h.stdout.join("\n")).toContain("--meta readOnly=false");
	});

	test("aws mode stores secret pointer meta and a placeholder, then tests", async () => {
		const rerunUnderAsm = mock(async (_ref: unknown, _verb: string, _args: readonly string[]) => 0);
		const h = setupHarness({ rerunUnderAsm });
		const code = await h.run([
			...PG_FLAGS,
			"--secret", "aws",
			"--secret-id", "prod/pg",
			"--secret-key", "password",
		]);
		expect(code ?? 0).toBe(0);
		expect(h.set).toHaveBeenCalledTimes(1);
		const [name, value, meta] = h.set.mock.calls[0] ?? [];
		expect(name).toBe("db/pg1");
		expect(value).toBe("aws-sm");
		expect(meta).toMatchObject({
			engine: "postgresql",
			readOnly: "true",
			secretSource: "aws-sm",
			secretId: "prod/pg",
			secretKey: "password",
		});
		expect(rerunUnderAsm).toHaveBeenCalledTimes(1);
		expect(rerunUnderAsm.mock.calls[0]?.slice(1)).toEqual(["test", ["pg1", "--session", "sess-1"]]);
		expect(h.stdout.filter((l) => l.startsWith("Next:"))).toEqual(["Next: dg-skills db tables pg1"]);
		expect(h.createCredentialClient).toHaveBeenCalledWith("sess-1");
	});

	test("prints one Next line with the fix when the test fails", async () => {
		const h = setupHarness({ rerunUnderAsm: async () => 1 });
		const code = await h.run([...PG_FLAGS, "--secret", "aws", "--secret-id", "i", "--secret-key", "k"]);
		expect(code).toBe(1);
		expect(h.stdout.filter((l) => l.startsWith("Next:"))).toHaveLength(1);
		expect(h.stdout.join("\n")).not.toContain("db tables");
	});

	test("external_browser stores its placeholder with no secret mode", async () => {
		const h = setupHarness({ sfTest: async () => "OK: snowflake" });
		const code = await h.run([
			"sf1", "--engine", "snowflake", "--account", "acme", "--user", "me", "--auth", "external_browser",
		]);
		expect(code ?? 0).toBe(0);
		const [, value, meta] = h.set.mock.calls[0] ?? [];
		expect(value).toBe("external_browser");
		expect(meta).toMatchObject({ authenticator: "external_browser", account: "acme", readOnly: "true" });
	});

	test("keypair stores privateKeyPath only", async () => {
		const h = setupHarness();
		const code = await h.run([
			"sf2", "--engine", "snowflake", "--account", "acme", "--user", "me",
			"--auth", "keypair", "--private-key-path", "/keys/k.p8", "--secret", "command",
		]);
		expect(code ?? 0).toBe(0);
		const line = h.stdout.find((l) => l.startsWith("dg-skills credentials")) ?? "";
		expect(line).toContain("--meta privateKeyPath=/keys/k.p8");
		expect(line).not.toContain("passphrase");
	});

	test("rejects a postgresql run with no database or user before touching the store", async () => {
		const h = setupHarness();
		const code = await h.run(["pg1", "--engine", "postgresql", "--secret", "aws", "--secret-id", "i", "--secret-key", "k"]);
		expect(code).toBe(1);
		expect(h.stderr.join("\n")).toMatch(/database/);
		expect(h.createCredentialClient).not.toHaveBeenCalled();
		expect(h.set).not.toHaveBeenCalled();
	});

	test("rejects aws mode without secret id and key", async () => {
		const h = setupHarness();
		const code = await h.run([...PG_FLAGS, "--secret", "aws"]);
		expect(code).toBe(1);
		expect(h.stderr.join("\n")).toMatch(/--secret-id/);
		expect(h.set).not.toHaveBeenCalled();
	});

	test("rejects a secret mode with external_browser", async () => {
		const h = setupHarness();
		const code = await h.run([
			"sf1", "--engine", "snowflake", "--account", "acme", "--user", "me",
			"--auth", "external_browser", "--secret", "command",
		]);
		expect(code).toBe(1);
		expect(h.stderr.join("\n")).toContain("external_browser needs no --secret");
		expect(h.set).not.toHaveBeenCalled();
	});

	test.each(["0", "65536", "99999", "5432x"])("rejects --port %s", async (port) => {
		const h = setupHarness();
		const flags = [...PG_FLAGS];
		flags[flags.indexOf("--port") + 1] = port;
		const code = await h.run([...flags, "--secret", "command"]);
		expect(code).toBe(1);
		expect(h.stderr.join("\n")).toContain("--port must be an integer from 1 to 65535");
	});

	test("form mode asks the daemon for the form, so it fails when no daemon runs", async () => {
		const h = setupHarness();
		const code = await h.run([...PG_FLAGS, "--secret", "form"]);
		expect(code).toBe(1);
		expect(h.stderr.join("\n")).toContain("dg-daemon is not running");
		expect(h.pgTest).not.toHaveBeenCalled();
	});
});

describe("db verbs and --session", () => {
	test("tables forwards --session to the credential client factory", async () => {
		const createCredentialClient = mock((_session?: string) => ({
			get: async () => ({
				value: "x",
				meta: { engine: "postgresql", database: "app", user: "u" },
				updatedAt: "2026-01-01T00:00:00Z",
			}),
			list: async () => [],
			set: async () => {},
			close: () => {},
		}));
		const spec = createDbSpec({
			createCredentialClient,
			pgConnect: async () => ({ connect: async () => {}, query: async () => ({ rows: [] }), end: async () => {} }),
			pgTables: async () => [],
			stdout: () => {},
			stderr: () => {},
		});
		await spec.subcommands.tables?.run(["pg1", "--session", "sess-7"], NO_OPTS);
		expect(createCredentialClient).toHaveBeenCalledWith("sess-7");
	});

	test("query --write on a readOnly connection exits 1 and never connects", async () => {
		const stderr: string[] = [];
		const pgConnect = mock(async () => {
			throw new Error("should not connect");
		});
		const spec = createDbSpec({
			createCredentialClient: () => ({
				get: async () => ({
					value: "x",
					meta: { engine: "postgresql", database: "app", user: "u", readOnly: "true" },
					updatedAt: "2026-01-01T00:00:00Z",
				}),
				list: async () => [],
				set: async () => {},
				close: () => {},
			}),
			pgConnect,
			stdout: () => {},
			stderr: (line) => stderr.push(line),
		});
		const code = await spec.subcommands.query?.run(["pg1", "UPDATE t SET a = 1", "--write"], NO_OPTS);
		expect(code).toBe(1);
		expect(stderr.join("\n")).toMatch(/read-only/);
		expect(pgConnect).not.toHaveBeenCalled();
	});
});
