import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialMeta } from "@dg/common";
import { createDbSpec } from "../src/db";
import { asmExecArgv, placeholder } from "../src/db/aws-secret";
import { type DbCredentialClient, getConnection } from "../src/db/credentials";

const NO_OPTS = { json: false, help: false };
const FAKE_SECRET = "fake-secret-value-123";
const PG_META: CredentialMeta = {
	engine: "postgresql",
	host: "127.0.0.1",
	database: "app",
	user: "ro",
	secretSource: "aws-sm",
	secretId: "db/prod",
	secretKey: "password",
};

function client(meta: CredentialMeta): DbCredentialClient {
	return {
		get: mock(async () => ({ value: "aws-sm", meta, updatedAt: "2026-01-01T00:00:00Z" })),
		list: mock(async () => []),
		set: mock(async () => {}),
		close: mock(() => {}),
	};
}

describe("aws-sm secret reference", () => {
	let dir = "";
	const saved = { ...process.env };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "asm-"));
		delete process.env.DG_DB_ASM_CHILD;
		delete process.env.DG_DB_SECRET;
	});

	afterEach(() => {
		process.env = { ...saved };
		rmSync(dir, { recursive: true, force: true });
	});

	function installFakeAsm(exitCode = 0): string {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const log = join(dir, "asm.log");
		const script = join(bin, "asm-exec");
		writeFileSync(
			script,
			`#!/bin/sh\n{ for a in "$@"; do printf 'ARG:%s\\n' "$a"; done; printf 'CHILD:%s\\nPROFILE:%s\\nREGION:%s\\n' "$DG_DB_ASM_CHILD" "$AWS_PROFILE" "$AWS_REGION"; } >> "${log}"\necho fake-out\nexit ${exitCode}\n`,
		);
		chmodSync(script, 0o755);
		process.env.PATH = `${bin}:${saved.PATH}`;
		return log;
	}

	function harness(meta: CredentialMeta) {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const spec = createDbSpec({
			createCredentialClient: () => client(meta),
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
		});
		return { spec, stdout, stderr };
	}

	test("placeholder builds the resolve reference", () => {
		expect(placeholder("db/prod", "password")).toBe(
			"{{resolve:secretsmanager:db/prod:SecretString:password}}",
		);
	});

	test("asmExecArgv wraps a command in asm-exec and env", () => {
		expect(asmExecArgv({ id: "db/prod", key: "password" }, ["dg-skills", "db", "test", "c"])).toEqual([
			"asm-exec",
			"--",
			"env",
			"DG_DB_SECRET={{resolve:secretsmanager:db/prod:SecretString:password}}",
			"dg-skills",
			"db",
			"test",
			"c",
		]);
	});

	test("the child uses DG_DB_SECRET as the password", async () => {
		process.env.DG_DB_ASM_CHILD = "1";
		process.env.DG_DB_SECRET = FAKE_SECRET;
		const connection = await getConnection(client(PG_META), "c");
		expect(connection.password).toBe(FAKE_SECRET);
		expect(connection.awsSecret).toBeUndefined();
	});

	test("the child fails clearly when the secret is missing or unresolved", async () => {
		process.env.DG_DB_ASM_CHILD = "1";
		await expect(getConnection(client(PG_META), "c")).rejects.toThrow(/DG_DB_SECRET/);
		process.env.DG_DB_SECRET = placeholder("db/prod", "password");
		const error = await getConnection(client(PG_META), "c").catch((e: Error) => e);
		expect((error as Error).message).toMatch(/DG_DB_SECRET/);
		expect((error as Error).message).not.toContain("{{resolve:");
	});

	test("the parent re-runs the verb once under asm-exec with the placeholder", async () => {
		const log = installFakeAsm(3);
		const h = harness({ ...PG_META, awsProfile: "work", awsRegion: "us-west-2" });
		const test_ = h.spec.subcommands.query;
		const code = await test_?.run(["c", "SELECT 1", "--limit", "5"], NO_OPTS);
		expect([code, h.stderr]).toEqual([3, []]);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines.filter((l) => l === "ARG:--")).toHaveLength(1);
		expect(lines.filter((l) => l === "ARG:env")).toHaveLength(1);
		expect(lines).toContain(`ARG:DG_DB_SECRET=${placeholder("db/prod", "password")}`);
		const tail = lines.filter((l) => l.startsWith("ARG:")).slice(-5).map((l) => l.slice(4));
		expect(tail).toEqual(["query", "c", "SELECT 1", "--limit", "5"]);
		expect(lines).toContain("CHILD:1");
		expect(lines).toContain("PROFILE:work");
		expect(lines).toContain("REGION:us-west-2");
		expect(readFileSync(log, "utf8")).not.toContain(FAKE_SECRET);
		expect(h.stdout.join("")).not.toContain(FAKE_SECRET);
	});

	test("db test also re-runs under asm-exec", async () => {
		const log = installFakeAsm();
		const h = harness(PG_META);
		expect(await h.spec.subcommands.test?.run(["c"], NO_OPTS)).toBe(0);
		const args = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("ARG:"));
		expect(args.slice(-3)).toEqual(["ARG:db", "ARG:test", "ARG:c"]);
	});

	test("a missing asm-exec exits 1 and names asm-exec with an install hint", async () => {
		const empty = join(dir, "empty");
		mkdirSync(empty);
		process.env.PATH = empty;
		const h = harness(PG_META);
		expect(await h.spec.subcommands.tables?.run(["c"], NO_OPTS)).toBe(1);
		const text = h.stderr.join("\n");
		expect(text).toContain("asm-exec");
		expect(text).toContain("aws-core");
	});

	test("setup stores awsProfile and awsRegion for --secret aws", async () => {
		const set = mock(async (_n: string, _v: string, _m?: CredentialMeta) => {});
		const h = createDbSpec({
			createCredentialClient: () => ({ ...client(PG_META), set }),
			ensureSession: async () => "s",
			stdout: () => {},
			stderr: () => {},
			rerunUnderAsm: async () => 0,
		});
		const code = await h.subcommands.setup?.run(
			["pg1", "--engine", "postgresql", "--database", "app", "--user", "ro", "--secret", "aws", "--secret-id", "i", "--secret-key", "k", "--aws-profile", "work", "--aws-region", "eu-west-1"],
			NO_OPTS,
		);
		expect(code ?? 0).toBe(0);
		expect(set.mock.calls[0]?.[2]).toMatchObject({ awsProfile: "work", awsRegion: "eu-west-1" });
	});

	test("setup rejects aws flags without --secret aws", async () => {
		const stderr: string[] = [];
		const h = createDbSpec({
			createCredentialClient: () => client(PG_META),
			ensureSession: async () => "s",
			stdout: () => {},
			stderr: (l) => stderr.push(l),
		});
		const code = await h.subcommands.setup?.run(
			["pg1", "--engine", "postgresql", "--database", "app", "--user", "ro", "--secret", "form", "--aws-region", "x"],
			NO_OPTS,
		);
		expect(code).toBe(1);
		expect(stderr.join("")).toContain("--secret aws");
	});

	test("no db source references the Secrets Manager read APIs", () => {
		const root = join(import.meta.dir, "..", "src", "db");
		const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const text = readFileSync(join(root, file), "utf8");
			expect(text).not.toMatch(/get-secret-value|batch-get-secret-value|GetSecretValueCommand/);
		}
	});
});
