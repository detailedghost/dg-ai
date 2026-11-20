import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
	SERVICE_API_CREDENTIALS_PATH,
} from "@dg/common";
import {
	type DgPaths,
	jobStateDir,
	resolveDgPaths,
	writeCredentialGrantToken,
} from "@dg/common/node";
import { waitUntil } from "../commands/job-cli-helpers";
import { addFixture, makeRepo, runJob, sandbox } from "../commands/job-source-kit";
import { setupFile } from "../commands/job-setup-kit";
import type { JobDecl, ParsedJob } from "../../src/jobs/config";
import { createRefreshLimiter } from "../../src/jobs/credential-refresh";
import { SecretFetchError, type RunSource } from "../../src/jobs/secret-sources";
import { writeSource } from "../../src/jobs/sources";
import { handleServiceApiCredentials } from "../../src/server/service-api";
import { ChatStore } from "../../src/store";
import { CredentialStore } from "../../src/store/credentials-store";
import {
	allocatePort,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	spawnServe,
	stopServe,
	waitForHealth,
} from "../utils/daemon-harness";

const VALUE = "fixture-value-refresh-route-6b21";
const OLD = "fixture-value-refresh-old-0c88";
const NAME = "bot/api/dev";
const NOT_ALLOWED = "Credential request not allowed for this caller.";
const SOURCE = { type: "aws-secretsmanager", secretId: "prod/api", region: "us-east-1" };
const SUFFIX = " — run dg job setup bot --refresh";

const decl = (name: string, extra: Partial<JobDecl> = {}): ParsedJob => ({
	ok: true,
	name,
	mode: "continuous",
	argv: ["x"],
	cwd: "/",
	enabled: true,
	feed: false,
	credentials: ["api/dev", "api/prod"],
	passEnv: [],
	stopTimeoutMs: 1000,
	grant: "bot",
	credentialEnv: {},
	...extra,
});

const rigs: { close(): void }[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.close();
});

async function makeRig() {
	const dgHome = freshDgHome();
	const paths: DgPaths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const chat = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	const store = await CredentialStore.open(paths, chat.cryptoMeta(), FILE_ONLY_SEAMS);
	const token = store.createCredentialGrant("bot");
	const tokenPath = writeCredentialGrantToken(paths, "bot", token);
	const otherToken = store.createCredentialGrant("other");
	const toolsToken = store.createCredentialGrant("tools");
	const reservedTokens = { pw: store.createCredentialGrant("pw"), db: store.createCredentialGrant("db") };
	const envFile = (key: string) => {
		const file = join(dgHome, `${key}.env`);
		writeFileSync(file, `${key}=1\n`);
		chmodSync(file, 0o600);
		return file;
	};
	writeSource(paths, "bot", {
		kind: "path",
		path: dgHome,
		jobs: ["bot", "a", "b", "moved"],
		credentials: { "api/dev": { source: SOURCE }, "api/prod": { source: { ...SOURCE, key: "K" } }, "api/none": {} },
		setupDone: ["bot", "a", "b", "moved"],
	});
	const jobs: ParsedJob[] = [
		decl("bot", { envFile: envFile("BOT") }),
		decl("a", { envFile: envFile("AAA") }),
		decl("b", { envFile: envFile("BBB") }),
		decl("cmd"),
		decl("elsewhere", { grant: "other" }),
		decl("moved", { grant: "tools" }),
		decl("sealed", { grant: "pw" }),
		decl("reserved", { grant: "db" }),
		{ ok: false, name: "broken", error: "bad" },
	];
	const calls: { argv: string[]; env: Record<string, string | undefined>; cwd?: string }[] = [];
	const logs: string[] = [];
	const state = {
		clock: 1_000_000,
		which: (name: string): string | null => (name === "aws" ? "/fake/bin/aws" : null),
		stdout: `${VALUE}\n`,
		code: 0,
		stderr: "",
		throws: undefined as unknown,
		jobsThrow: false,
	};
	const runSource: RunSource = async (argv, options) => {
		calls.push({ argv, env: options.env, cwd: options.cwd });
		if (state.throws !== undefined) throw state.throws;
		return { code: state.code, stdout: state.stdout, stderr: state.stderr };
	};
	const logger = {
		info: (line: string) => void logs.push(line),
		warn: (line: string) => void logs.push(line),
		error: (line: string) => void logs.push(line),
	};
	const refresh = {
		paths,
		readJobs: () => {
			if (state.jobsThrow) throw new Error("jobs unreadable");
			return jobs;
		},
		which: (name: string) => state.which(name),
		runSource,
		now: () => state.clock,
		limiter: createRefreshLimiter(),
	};
	type Call = {
		body?: unknown;
		rawBody?: string;
		headers?: Record<string, string | null>;
		method?: string;
	};
	async function post(call: Call = {}): Promise<Response> {
		const headers: Record<string, string | null> = {
			"Content-Type": "application/json",
			[CLI_GRANT_PREFIX_HEADER]: "bot",
			[CLI_GRANT_TOKEN_HEADER]: token,
			...call.headers,
		};
		const sent = Object.fromEntries(
			Object.entries(headers).filter(([, value]) => value !== null),
		) as Record<string, string>;
		const method = call.method ?? "POST";
		return handleServiceApiCredentials(
			new Request(`http://127.0.0.1:1${SERVICE_API_CREDENTIALS_PATH}`, {
				method,
				headers: sent,
				...(method === "POST"
					? { body: call.rawBody ?? JSON.stringify(call.body ?? { operation: "refresh", name: NAME, job: "bot" }) }
					: {}),
			}),
			store,
			logger,
			refresh,
		);
	}
	const rig = {
		dgHome,
		paths,
		store,
		token,
		otherToken,
		toolsToken,
		reservedTokens,
		tokenPath,
		calls,
		logs,
		state,
		refresh,
		post,
		refreshOf: (name = NAME, job = "bot") => post({ body: { operation: "refresh", name, job } }),
		close() {
			store.close();
			chat.close();
			cleanupDgHome(dgHome);
		},
	};
	rigs.push(rig);
	return rig;
}

const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("POST /service-api/v1/credentials refresh", () => {
	it("answers 200 with the name and the time and no value, and get then reads the new value", async () => {
		const rig = await makeRig();
		rig.store.setCredential(NAME, OLD, { tag: "kept" });
		const response = await rig.refreshOf();
		const text = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(text).not.toContain(VALUE);
		const body = JSON.parse(text) as { ok: boolean; value: { name: string; updatedAt: string } };
		expect(body.ok).toBe(true);
		expect(Object.keys(body.value)).toEqual(["name", "updatedAt"]);
		expect(body.value.name).toBe(NAME);
		expect(new Date(body.value.updatedAt).toISOString()).toBe(body.value.updatedAt);
		const got = await rig.post({ body: { operation: "get", name: NAME } });
		expect(((await bodyOf(got)).value as { value: string }).value).toBe(VALUE);
	});

	it("gives runSource the AWS argv, the env file of the job and no grant file", async () => {
		const rig = await makeRig();
		await rig.refreshOf();
		expect(rig.calls).toHaveLength(1);
		expect(rig.calls[0]?.argv).toEqual([
			"/fake/bin/aws",
			"secretsmanager",
			"get-secret-value",
			"--secret-id",
			"prod/api",
			"--region",
			"us-east-1",
			"--query",
			"SecretString",
			"--output",
			"text",
		]);
		expect(rig.calls[0]?.env.BOT).toBe("1");
		expect(rig.calls[0]?.env.DG_CREDENTIAL_GRANT_FILE).toBeUndefined();
		expect(rig.calls[0]?.cwd).toBe(jobStateDir(rig.paths, "bot"));
	});

	it("gives a job that names another job of the same prefix the environment of that job", async () => {
		const rig = await makeRig();
		await rig.refreshOf(NAME, "b");
		expect(rig.calls[0]?.env.BBB).toBe("1");
		expect(rig.calls[0]?.env.AAA).toBeUndefined();
		expect(rig.calls[0]?.env.BOT).toBeUndefined();
	});

	it("keeps the bytes of the grant token file", async () => {
		const rig = await makeRig();
		const before = readFileSync(rig.tokenPath);
		await rig.refreshOf();
		expect(readFileSync(rig.tokenPath).equals(before)).toBe(true);
		expect(rig.store.verifyCredentialGrant("bot", rig.token)).toBe(true);
	});

	describe("guards", () => {
		it("answers 401 with no grant and with an incorrect token", async () => {
			const rig = await makeRig();
			const attempts: Record<string, string | null>[] = [
				{ [CLI_GRANT_TOKEN_HEADER]: null },
				{ [CLI_GRANT_PREFIX_HEADER]: null },
				{ [CLI_GRANT_TOKEN_HEADER]: "wrong-token" },
			];
			for (const headers of attempts) {
				expect((await rig.post({ headers })).status).toBe(401);
			}
			expect(rig.calls).toHaveLength(0);
		});

		it("answers 400 for an Origin header", async () => {
			const rig = await makeRig();
			const response = await rig.post({ headers: { Origin: "https://evil.example" } });
			expect(response.status).toBe(400);
			expect(rig.calls).toHaveLength(0);
		});

		it("answers 415 for another content type", async () => {
			const rig = await makeRig();
			expect((await rig.post({ headers: { "Content-Type": "text/plain" } })).status).toBe(415);
		});

		it("answers 413 above 64 KiB", async () => {
			const rig = await makeRig();
			const big = JSON.stringify({ operation: "refresh", name: NAME, job: "bot", pad: "x".repeat(70_000) });
			expect((await rig.post({ rawBody: big })).status).toBe(413);
		});

		it("answers 400 when name or job is absent or is not a string", async () => {
			const rig = await makeRig();
			for (const body of [
				{ operation: "refresh", job: "bot" },
				{ operation: "refresh", name: NAME },
				{ operation: "refresh", name: 5, job: "bot" },
				{ operation: "refresh", name: NAME, job: ["bot"] },
			]) {
				expect((await rig.post({ body })).status).toBe(400);
			}
			expect(rig.calls).toHaveLength(0);
		});

		it("answers 400 for a body key that is not supported and starts no process", async () => {
			const rig = await makeRig();
			const response = await rig.post({
				body: { operation: "refresh", name: NAME, job: "bot", secretId: "x" },
			});
			expect(response.status).toBe(400);
			expect(await bodyOf(response)).toEqual({
				ok: false,
				error: 'request body key "other" is not supported',
			});
			const profile = await rig.post({
				body: { operation: "refresh", name: NAME, job: "bot", profile: "x", region: "y" },
			});
			expect(profile.status).toBe(400);
			expect(rig.calls).toHaveLength(0);
		});

		it("names job in the stray key answer of get", async () => {
			const rig = await makeRig();
			const response = await rig.post({ body: { operation: "get", name: NAME, job: "bot" } });
			expect(await bodyOf(response)).toEqual({ ok: false, error: 'request body key "job" is not supported' });
		});

		it("answers 400 for a name that is not valid", async () => {
			const rig = await makeRig();
			expect((await rig.refreshOf("bot/UP PER")).status).toBe(400);
			expect(rig.calls).toHaveLength(0);
		});

		it("answers 403 for a name outside the prefix", async () => {
			const rig = await makeRig();
			const response = await rig.refreshOf("other/api/dev");
			expect(response.status).toBe(403);
			expect(await bodyOf(response)).toEqual({ ok: false, error: NOT_ALLOWED });
		});

		it("answers 403 for a job that is not in the table, has another grant or is not valid", async () => {
			const rig = await makeRig();
			for (const job of ["nobody", "elsewhere", "broken"]) {
				const response = await rig.refreshOf(NAME, job);
				expect(response.status).toBe(403);
				expect(await bodyOf(response)).toEqual({ ok: false, error: NOT_ALLOWED });
			}
			expect(rig.calls).toHaveLength(0);
		});

		it("answers 403 and no 60 s window for a refused request", async () => {
			const rig = await makeRig();
			expect((await rig.refreshOf(NAME, "nobody")).status).toBe(403);
			expect((await rig.refreshOf()).status).toBe(200);
		});

		it("still refuses an operation that is not get, list or refresh", async () => {
			const rig = await makeRig();
			expect((await rig.post({ body: { operation: "set", name: NAME, value: "v" } })).status).toBe(403);
		});
	});

	describe("prefix rules", () => {
		const asPrefix = (prefix: string, token: string) => ({
			[CLI_GRANT_PREFIX_HEADER]: prefix,
			[CLI_GRANT_TOKEN_HEADER]: token,
		});

		it("answers 403 for a reserved or sealed grant prefix before the name checks", async () => {
			const rig = await makeRig();
			for (const [prefix, job] of [["pw", "sealed"], ["db", "reserved"]] as const) {
				const response = await rig.post({
					headers: asPrefix(prefix, rig.reservedTokens[prefix]),
					body: { operation: "refresh", name: `${prefix}/api/dev`, job },
				});
				expect(response.status).toBe(403);
				expect(await bodyOf(response)).toEqual({ ok: false, error: NOT_ALLOWED });
				const badName = await rig.post({
					headers: asPrefix(prefix, rig.reservedTokens[prefix]),
					body: { operation: "refresh", name: `${prefix}/BAD NAME`, job },
				});
				expect(badName.status).toBe(403);
			}
			expect(rig.calls).toHaveLength(0);
		});

		it("answers 409 when the record key is not the grant of the job", async () => {
			const rig = await makeRig();
			const response = await rig.post({
				headers: asPrefix("tools", rig.toolsToken),
				body: { operation: "refresh", name: "tools/api/dev", job: "moved" },
			});
			expect(response.status).toBe(409);
			expect((await bodyOf(response)).error).toBe(
				'credential "tools/api/dev" has no source — run dg job setup moved',
			);
			expect(rig.calls).toHaveLength(0);
		});

		it("compares the header prefix in lower case", async () => {
			const rig = await makeRig();
			const response = await rig.post({
				headers: asPrefix("BOT", rig.token),
				body: { operation: "refresh", name: NAME, job: "bot" },
			});
			expect(response.status).toBe(200);
		});
	});

	describe("409", () => {
		it("answers the has no source text and starts no process", async () => {
			const rig = await makeRig();
			const cases: [string, string][] = [
				["bot/api/none", "bot"],
				["bot/api/unlisted", "bot"],
				[NAME, "cmd"],
			];
			for (const [name, job] of cases) {
				const response = await rig.refreshOf(name, job);
				expect(response.status).toBe(409);
				expect(await bodyOf(response)).toEqual({
					ok: false,
					error: `credential "${name}" has no source — run dg job setup ${job}`,
				});
			}
			expect(rig.calls).toHaveLength(0);
		});

		it("does not start the window", async () => {
			const rig = await makeRig();
			await rig.refreshOf(NAME, "cmd");
			expect((await rig.refreshOf()).status).toBe(200);
		});
	});

	describe("429", () => {
		it("limits one name to one fetch in 60 s and starts again 61 s later", async () => {
			const rig = await makeRig();
			expect((await rig.refreshOf()).status).toBe(200);
			rig.state.clock += 5_000;
			const second = await rig.refreshOf();
			expect(second.status).toBe(429);
			const body = await bodyOf(second);
			expect(body.retryAfter).toBe(55);
			expect(body.error).toBe(`refresh of ${NAME} is limited — try again in 55 s`);
			expect(rig.calls).toHaveLength(1);
			rig.state.clock += 56_000;
			expect((await rig.refreshOf()).status).toBe(200);
			expect(rig.calls).toHaveLength(2);
		});

		it("starts two fetches for two names", async () => {
			const rig = await makeRig();
			rig.state.stdout = `${JSON.stringify({ K: VALUE })}\n`;
			expect((await rig.refreshOf("bot/api/dev")).status).toBe(200);
			expect((await rig.refreshOf("bot/api/prod")).status).toBe(200);
			expect(rig.calls).toHaveLength(2);
		});

		it("answers 429 for a request during a fetch", async () => {
			const rig = await makeRig();
			let release: () => void = () => {};
			let entered: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const inner = rig.refresh.runSource;
			rig.refresh.runSource = async (argv, options) => {
				entered();
				await gate;
				return inner(argv, options);
			};
			const first = rig.refreshOf();
			await started;
			const second = await rig.refreshOf();
			expect(second.status).toBe(429);
			expect(((await bodyOf(second)).retryAfter as number) >= 1).toBe(true);
			release();
			expect((await first).status).toBe(200);
			expect(rig.calls).toHaveLength(1);
		});
	});

	describe("502 and 500", () => {
		it("answers 502 for a failed aws and keeps the stored value", async () => {
			const rig = await makeRig();
			rig.store.setCredential(NAME, OLD, { tag: "kept" });
			const before = rig.store.getCredential(NAME);
			rig.state.code = 255;
			rig.state.stderr = "AccessDenied for the role\nsecond line";
			const response = await rig.refreshOf();
			expect(response.status).toBe(502);
			expect(await bodyOf(response)).toEqual({
				ok: false,
				error: `aws failed for ${NAME}: AccessDenied for the role${SUFFIX}`,
			});
			expect(rig.store.getCredential(NAME)).toEqual(before);
			expect((await rig.refreshOf()).status).toBe(429);
		});

		it("answers 502 when aws does not resolve", async () => {
			const rig = await makeRig();
			rig.state.which = () => null;
			const response = await rig.refreshOf();
			expect(response.status).toBe(502);
			expect((await bodyOf(response)).error).toBe(`aws is not on the PATH of job "bot"${SUFFIX}`);
		});

		it("answers 502 with the key text and no part of the secret", async () => {
			const rig = await makeRig();
			rig.state.stdout = JSON.stringify({ other: VALUE });
			const response = await rig.refreshOf("bot/api/prod");
			const text = await response.text();
			expect(response.status).toBe(502);
			expect(JSON.parse(text).error).toBe(`the secret has no key "K"${SUFFIX}`);
			expect(text).not.toContain(VALUE);
			expect(rig.logs.join("\n")).not.toContain(VALUE);
		});

		it("answers 502 for text that is not JSON when a key is named", async () => {
			const rig = await makeRig();
			rig.state.stdout = "plain text";
			const response = await rig.refreshOf("bot/api/prod");
			expect((await bodyOf(response)).error).toBe(`the secret of bot/api/prod is not JSON${SUFFIX}`);
		});

		it("answers 502 for a timeout", async () => {
			const rig = await makeRig();
			rig.state.throws = new SecretFetchError("timeout", "timed out after 30 s");
			const response = await rig.refreshOf();
			expect(response.status).toBe(502);
			expect((await bodyOf(response)).error).toBe(`aws timed out for ${NAME}${SUFFIX}`);
		});

		it("answers 502 with the value text for a value that is not valid and stores nothing", async () => {
			const rig = await makeRig();
			rig.state.stdout = "x".repeat(70_000);
			const response = await rig.refreshOf();
			expect(response.status).toBe(502);
			expect((await bodyOf(response)).error).toBe(`the secret of ${NAME} is not a valid credential value${SUFFIX}`);
			expect(rig.store.getCredential(NAME)).toBeUndefined();
		});

		it("answers 500 with the storage text when the sources file is not valid and no path", async () => {
			const rig = await makeRig();
			writeFileSync(rig.paths.jobSourcesPath, "{ not json");
			const response = await rig.refreshOf();
			const text = await response.text();
			expect(response.status).toBe(500);
			expect(JSON.parse(text).error).toContain("Credential storage failed");
			expect(text).not.toContain(rig.dgHome);
			expect(rig.calls).toHaveLength(0);
		});

		it("answers 500 when the jobs table cannot be read", async () => {
			const rig = await makeRig();
			rig.state.jobsThrow = true;
			const response = await rig.refreshOf();
			expect(response.status).toBe(500);
			expect(await bodyOf(response)).toEqual({
				ok: false,
				error: "could not read the jobs table; check the dg config",
			});
			expect(rig.logs.join("\n")).not.toContain("jobs unreadable");
		});

		it("answers 500 with the storage text when the credential store is closed", async () => {
			const rig = await makeRig();
			rig.store.close();
			const response = await rig.refreshOf();
			expect(response.status).toBe(500);
			expect((await bodyOf(response)).error).toContain("Credential storage failed");
		});
	});

	describe("the daemon log", () => {
		it("logs a 400 for a type error and for a stray key", async () => {
			const rig = await makeRig();
			await rig.post({ body: { operation: "refresh", name: NAME } });
			await rig.post({ body: { operation: "refresh", name: NAME, job: "bot", secretId: "x" } });
			expect(rig.logs.filter((line) => line.includes("refresh:"))).toEqual([
				`service API refresh: job=? credential=${NAME} result=400`,
				`service API refresh: job=bot credential=${NAME} result=400`,
			]);
		});

		it("logs result=500 and answers the storage text when the refresh throws", async () => {
			const rig = await makeRig();
			writeFileSync(rig.paths.jobSourcesPath, "{ not json");
			const response = await rig.refreshOf();
			expect(response.status).toBe(500);
			expect(rig.logs).toContain(`service API refresh: job=bot credential=${NAME} result=500`);
			expect(rig.logs.join("\n")).not.toContain(rig.dgHome);
		});

		it("gets one line for each request with the job, the name and the result, and no value", async () => {
			const rig = await makeRig();
			await rig.refreshOf();
			await rig.refreshOf();
			await rig.refreshOf("bot/api/none");
			const lines = rig.logs.filter((line) => line.includes("refresh"));
			expect(lines).toEqual([
				`service API refresh: job=bot credential=${NAME} result=ok`,
				`service API refresh: job=bot credential=${NAME} result=429`,
				"service API refresh: job=bot credential=bot/api/none result=409",
			]);
			expect(rig.logs.join("\n")).not.toContain(VALUE);
			expect(rig.logs.join("\n")).not.toContain(rig.token);
		});
	});
});

const WRITE_SCRIPT = {
	content: `#!${process.execPath}
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const done = (state) =>
	writeFileSync(join(process.env.DG_SERVICE_STATE_DIR, process.env.DG_SERVICE_LABEL + ".got"), JSON.stringify(state));
setTimeout(() => {}, 600000);
(async () => {
	const prefix = process.env.DG_CREDENTIAL_GRANT_PREFIX;
	const token = readFileSync(process.env.DG_CREDENTIAL_GRANT_FILE, "utf8").trim();
	const call = async (body) => {
		const response = await fetch(process.env.DG_DAEMON_URL + "/service-api/v1/credentials", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Dg-Grant-Prefix": prefix, "X-Dg-Grant-Token": token },
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	};
	const name = prefix + "/token";
	const refreshed = await call({ operation: "refresh", name, job: process.env.DG_SERVICE_LABEL });
	const got = await call({ operation: "get", name });
	done({
		status: refreshed.status,
		error: refreshed.body.error,
		hash: createHash("sha256").update(got.body.value.value).digest("hex"),
	});
})().catch((error) => done({ error: String(error) }));
`,
	executable: true as const,
};

describe("refresh against a live daemon", () => {
	const box = sandbox(["tool", "sh"]);
	const procs: ReturnType<typeof spawnServe>[] = [];
	afterEach(async () => {
		for (const proc of procs.splice(0)) await stopServe(proc);
		box.cleanup();
	});

	it("lets a job send refresh and then get and read the value that the fixture aws program prints", async () => {
		const sb = box.create();
		const port = allocatePort();
		const bin = join(sb.dgHome, "fixture-bin");
		await Bun.write(
			join(bin, "aws"),
			`#!/bin/sh\nprintf '%s\\n' "${VALUE}"\n`,
		);
		chmodSync(join(bin, "aws"), 0o755);
		procs.push(spawnServe(sb.dgHome, port));
		await waitForHealth(port, 8000);
		await addFixture(
			sb,
			makeRepo({
				dg: {
					jobs: {
						bot: { argv: ["./bin/write"], continuous: true, credentials: ["token"], envFile: "bot.env" },
					},
					credentials: { token: { prompt: "Token", source: SOURCE } },
				},
				files: { "bin/write": WRITE_SCRIPT },
			}),
		);
		const envFile = join(jobStateDir(sb.paths, "bot"), "bot.env");
		mkdirSync(jobStateDir(sb.paths, "bot"), { recursive: true, mode: 0o700 });
		writeFileSync(envFile, `PATH=${bin}:/usr/bin:/bin\n`);
		chmodSync(envFile, 0o600);

		const result = await runJob(
			["enable", "bot", "--setup", setupFile({ version: 1, credentials: { token: { value: OLD } } })],
			{ ...sb.deps(), isTerminal: () => false },
		);

		expect(result.code).toBe(0);
		const got = join(jobStateDir(sb.paths, "bot"), "bot.got");
		await waitUntil(() => existsSync(got));
		const seen = JSON.parse(readFileSync(got, "utf8")) as { status: number; hash: string; error?: string };
		expect(seen.error).toBeUndefined();
		expect(seen.status).toBe(200);
		expect(seen.hash).toBe(createHash("sha256").update(VALUE).digest("hex"));
	});
});
