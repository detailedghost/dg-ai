import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_MAX_VALUE_BYTES } from "@dg/common";
import { type DgPaths, jobStateDir, resolveDgPaths } from "@dg/common/node";
import type { JobDecl } from "../../src/jobs/config";
import {
	createRefreshLimiter,
	type RefreshDeps,
	type RefreshResult,
	refreshCredential,
} from "../../src/jobs/credential-refresh";
import { type RunSource, SecretFetchError } from "../../src/jobs/secret-sources";
import { writeSource } from "../../src/jobs/sources";
import { ChatStore } from "../../src/store";
import { CredentialStore } from "../../src/store/credentials-store";
import { cleanupDgHome, FILE_ONLY_SEAMS, freshDgHome } from "../utils/daemon-harness";

const VALUE = "fixture-value-refresh-4d7a";
const NAME = "bot/api/dev";
const SOURCE = { type: "aws-secretsmanager", secretId: "prod/api", region: "us-east-1" };
const AWS = "/fake/bin/aws";
const FIRST_AWS_ARGV = [
	AWS,
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
];

type Fake = { result?: { code?: number; stdout?: string; stderr?: string }; throws?: unknown };
type Call = { argv: string[]; env: Record<string, string | undefined>; cwd?: string; timeoutMs: number };

type Kit = {
	dgHome: string;
	paths: DgPaths;
	store: CredentialStore;
	chat: ChatStore;
	calls: Call[];
	warnings: string[];
	clock: { now: number };
	fake: Fake;
	deps: RefreshDeps;
	decl: JobDecl;
	run(name?: string, job?: JobDecl): Promise<RefreshResult>;
	close(): void;
};

const kits: Kit[] = [];
afterEach(() => {
	for (const kit of kits.splice(0)) kit.close();
});

function makeDecl(name: string, extra: Partial<JobDecl> = {}): JobDecl {
	return {
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
	};
}

async function makeKit(options: { record?: boolean; credentials?: Record<string, unknown>; setupDone?: string[] } = {}): Promise<Kit> {
	const dgHome = freshDgHome();
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const chat = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	const store = await CredentialStore.open(paths, chat.cryptoMeta(), FILE_ONLY_SEAMS);
	if (options.record !== false) {
		writeSource(paths, "bot", {
			kind: "path",
			path: dgHome,
			jobs: ["bot"],
			credentials: options.credentials ?? {
				"api/dev": { source: SOURCE },
				"api/prod": { source: { ...SOURCE, key: "K" } },
				"api/none": {},
			},
			setupDone: options.setupDone ?? ["bot"],
		});
	}
	const envFile = join(dgHome, "bot.env");
	writeFileSync(envFile, "FIXTURE_KEY=from-env-file\n");
	chmodSync(envFile, 0o600);
	const calls: Call[] = [];
	const warnings: string[] = [];
	const clock = { now: 1_000_000 };
	const fake: Fake = {};
	const runSource: RunSource = async (argv, runOptions) => {
		calls.push({ argv, ...runOptions });
		if (fake.throws !== undefined) throw fake.throws;
		return { code: fake.result?.code ?? 0, stdout: fake.result?.stdout ?? `${VALUE}\n`, stderr: fake.result?.stderr ?? "" };
	};
	const deps: RefreshDeps = {
		which: (name) => (name === "aws" ? AWS : null),
		runSource,
		now: () => clock.now,
		limiter: createRefreshLimiter(),
		logger: { warn: (line) => void warnings.push(line) },
	};
	const decl = makeDecl("bot", { envFile });
	const kit: Kit = {
		dgHome,
		paths,
		store,
		chat,
		calls,
		warnings,
		clock,
		fake,
		deps,
		decl,
		run: (name = NAME, job = decl) => refreshCredential({ paths, store, job, name, deps }),
		close() {
			store.close();
			chat.close();
			cleanupDgHome(dgHome);
		},
	};
	kits.push(kit);
	return kit;
}

const failure = (result: RefreshResult) => {
	if (result.ok) throw new Error("expected a failure");
	return result;
};

describe("refreshCredential", () => {
	it("stores the fetched value and returns only the name and the time", async () => {
		const kit = await makeKit();
		const result = await kit.run();
		expect(result.ok).toBe(true);
		expect(JSON.stringify(result)).not.toContain(VALUE);
		expect(kit.store.getCredential(NAME)?.value).toBe(VALUE);
		const stored = kit.store.listCredentials().find((entry) => entry.name === NAME);
		expect(result).toEqual({ ok: true, updatedAt: stored?.updatedAt as string });
		expect(Date.parse((result as { updatedAt: string }).updatedAt)).not.toBeNaN();
	});

	it("runs the AWS argv in the state folder of the job with the base environment", async () => {
		const kit = await makeKit();
		await kit.run();
		expect(kit.calls).toHaveLength(1);
		const [call] = kit.calls;
		expect(call?.argv).toEqual(FIRST_AWS_ARGV);
		expect(call?.cwd).toBe(jobStateDir(kit.paths, "bot"));
		expect(call?.timeoutMs).toBe(30000);
		expect(call?.env.FIXTURE_KEY).toBe("from-env-file");
		expect(Object.keys(call?.env ?? {}).filter((key) => key.startsWith("DG_") && key !== "DG_HOME")).toEqual([]);
		expect(call?.env.DG_CREDENTIAL_GRANT_FILE).toBeUndefined();
	});

	it("passes a key that the source names and uses the profile of the record only", async () => {
		const kit = await makeKit({
			credentials: { "api/dev": { source: { ...SOURCE, key: "K", profile: "recorded" } } },
		});
		kit.fake.result = { stdout: JSON.stringify({ K: VALUE }) };
		expect((await kit.run()).ok).toBe(true);
		expect(kit.calls[0]?.argv).toContain("recorded");
		expect(kit.store.getCredential(NAME)?.value).toBe(VALUE);
	});

	it("keeps each meta key from before and sets the provider and the creator", async () => {
		const kit = await makeKit();
		kit.store.setCredential(NAME, "old-value-1", { tag: "keep", provider: "other", createdBy: "someone" });
		await kit.run();
		expect(kit.store.getCredential(NAME)?.meta).toEqual({
			tag: "keep",
			provider: "aws-secretsmanager",
			createdBy: "service api refresh",
		});
	});

	it("gives a credential that was not stored only the provider and the creator", async () => {
		const kit = await makeKit();
		await kit.run();
		expect(kit.store.getCredential(NAME)?.meta).toEqual({
			provider: "aws-secretsmanager",
			createdBy: "service api refresh",
		});
	});

	it("matches the name and the record keys without regard to letter case", async () => {
		const kit = await makeKit({ credentials: { "API/Dev": { source: SOURCE } } });
		expect((await kit.run("BOT/api/DEV")).ok).toBe(true);
		expect(kit.store.getCredential(NAME)?.value).toBe(VALUE);
	});

	describe("409 with the has no source text", () => {
		const text = (job: string, name = NAME) => `credential "${name}" has no source — run dg job setup ${job}`;

		it("answers it for a job with no record", async () => {
			const kit = await makeKit({ record: false });
			const result = failure(await kit.run());
			expect(result).toMatchObject({ status: 409, error: text("bot") });
			expect(kit.calls).toHaveLength(0);
		});

		it("answers it for a command record, a credential with no details and one with no source", async () => {
			const none = await makeKit({ credentials: {} });
			expect(failure(await none.run())).toMatchObject({ status: 409, error: text("bot") });
			const bare = await makeKit();
			expect(failure(await bare.run("bot/api/none"))).toMatchObject({ status: 409 });
			expect(bare.calls).toHaveLength(0);
		});

		it("answers it for a name that the job does not list", async () => {
			const kit = await makeKit();
			expect(failure(await kit.run("bot/other"))).toMatchObject({ status: 409, error: text("bot", "bot/other") });
			expect(kit.calls).toHaveLength(0);
		});

		it("answers it when no person ran setup for the job", async () => {
			const kit = await makeKit({ setupDone: [] });
			expect(failure(await kit.run())).toMatchObject({ status: 409, error: text("bot") });
			expect(kit.calls).toHaveLength(0);
		});

		it("does not start the 60 s window", async () => {
			const kit = await makeKit();
			await kit.run("bot/other");
			expect((await kit.run()).ok).toBe(true);
		});
	});

	describe("502 answers", () => {
		const suffix = " — run dg job setup bot --refresh";

		const cases: [string, Fake, string, (kit: Kit) => void][] = [
			["failed", { result: { code: 255, stderr: "\nAccessDenied here\nsecond line" } }, `aws failed for ${NAME}: AccessDenied here`, () => {}],
			["timeout", { throws: new SecretFetchError("timeout", "timed out after 30 s") }, `aws timed out for ${NAME}`, () => {}],
			["no-text", { result: { stdout: "None\n" } }, `the secret of ${NAME} has no text value`, () => {}],
			["invalid-json", { result: { stdout: "not json" } }, `the secret of ${NAME} is not JSON`, () => {}],
		];

		for (const [label, fake, text] of cases) {
			it(`ends the ${label} text with the setup command`, async () => {
				const kit = await makeKit({
					credentials: {
						"api/dev": { source: label === "invalid-json" ? { ...SOURCE, key: "K" } : SOURCE },
					},
				});
				Object.assign(kit.fake, fake);
				const result = failure(await kit.run());
				expect(result.status).toBe(502);
				expect(result.error).toBe(`${text}${suffix}`);
			});
		}

		it("names the missing key and never part of the secret", async () => {
			const kit = await makeKit({ credentials: { "api/dev": { source: { ...SOURCE, key: "K" } } } });
			kit.fake.result = { stdout: JSON.stringify({ other: VALUE }) };
			const result = failure(await kit.run());
			expect(result).toMatchObject({ status: 502, error: `the secret has no key "K"${suffix}` });
			expect(result.error).not.toContain(VALUE);
		});

		it("answers not on the PATH when aws does not resolve", async () => {
			const kit = await makeKit();
			kit.deps.which = () => null;
			expect(failure(await kit.run())).toMatchObject({
				status: 502,
				error: `aws is not on the PATH of job "bot"${suffix}`,
			});
			expect(kit.calls).toHaveLength(0);
		});

		it("does not resolve aws from a relative PATH entry", async () => {
			const kit = await makeKit();
			mkdirSync(join(kit.dgHome, "rel"));
			writeFileSync(join(kit.dgHome, "rel", "aws"), "#!/bin/sh\n", { mode: 0o755 });
			writeFileSync(kit.decl.envFile as string, "PATH=rel\n");
			chmodSync(kit.decl.envFile as string, 0o600);
			kit.deps.which = (name, env) => Bun.which(name, { PATH: env?.PATH ?? "", cwd: kit.dgHome });
			expect(failure(await kit.run())).toMatchObject({ status: 502 });
			expect(kit.calls).toHaveLength(0);
		});

		it("answers not on the PATH when which returns a relative path", async () => {
			const kit = await makeKit();
			kit.deps.which = () => "aws";
			expect(failure(await kit.run()).error).toContain("is not on the PATH of job");
		});

		it("counts a failed fetch in the 60 s window and stores nothing", async () => {
			const kit = await makeKit();
			kit.store.setCredential(NAME, "old-value-1", { tag: "x" });
			const before = kit.store.getCredential(NAME);
			kit.fake.result = { code: 1, stderr: "boom" };
			expect(failure(await kit.run()).status).toBe(502);
			expect(failure(await kit.run()).status).toBe(429);
			expect(kit.store.getCredential(NAME)).toEqual(before);
		});

		it("cuts the stderr line at 200 characters", async () => {
			const kit = await makeKit();
			kit.fake.result = { code: 1, stderr: `${"x".repeat(500)}\n` };
			const result = failure(await kit.run());
			expect(result.error).toBe(`aws failed for ${NAME}: ${"x".repeat(200)}${suffix}`);
		});

		it("answers with the env file text and no path for an absent or invalid file", async () => {
			const absent = await makeKit();
			const decl = makeDecl("bot", { envFile: join(absent.dgHome, "missing.env") });
			const result = failure(await absent.run(NAME, decl));
			expect(result).toMatchObject({ status: 502, error: `the env file of job "bot" cannot be read${suffix}` });
			expect(result.error).not.toContain(absent.dgHome);
			expect(absent.calls).toHaveLength(0);

			const bad = await makeKit();
			writeFileSync(bad.decl.envFile as string, "not a pair\n");
			chmodSync(bad.decl.envFile as string, 0o600);
			expect(failure(await bad.run()).error).toBe(`the env file of job "bot" cannot be read${suffix}`);
		});

		it("answers with the value text and stores nothing for a value that is not valid", async () => {
			const kit = await makeKit();
			kit.fake.result = { stdout: "x".repeat(CREDENTIAL_MAX_VALUE_BYTES + 1) };
			const result = failure(await kit.run());
			expect(result).toMatchObject({
				status: 502,
				error: `the secret of ${NAME} is not a valid credential value${suffix}`,
			});
			expect(kit.store.getCredential(NAME)).toBeUndefined();
		});
	});

	describe("the 60 s window", () => {
		it("refuses a second request for one name and counts down", async () => {
			const kit = await makeKit();
			expect((await kit.run()).ok).toBe(true);
			kit.clock.now += 10_500;
			const second = failure(await kit.run());
			expect(second.status).toBe(429);
			expect(second.retryAfter).toBe(50);
			expect(second.error).toBe(`refresh of ${NAME} is limited — try again in 50 s`);
			expect(kit.calls).toHaveLength(1);
		});

		it("starts a fetch again 61 s later", async () => {
			const kit = await makeKit();
			await kit.run();
			kit.clock.now += 61_000;
			expect((await kit.run()).ok).toBe(true);
			expect(kit.calls).toHaveLength(2);
		});

		it("starts two fetches for two names", async () => {
			const kit = await makeKit();
			expect((await kit.run("bot/api/dev")).ok).toBe(true);
			expect((await kit.run("bot/api/prod")).ok).toBe(false);
			expect(kit.calls).toHaveLength(2);
		});

		it("answers 429 with retryAfter of 1 or more during a fetch", async () => {
			const kit = await makeKit();
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const inner = kit.deps.runSource;
			kit.deps.runSource = async (argv, options) => {
				await gate;
				return inner(argv, options);
			};
			const first = kit.run();
			await Bun.sleep(5);
			kit.clock.now += 70_000;
			const second = failure(await kit.run());
			expect(second.status).toBe(429);
			expect(second.retryAfter).toBeGreaterThanOrEqual(1);
			release();
			expect((await first).ok).toBe(true);
			expect(kit.calls).toHaveLength(1);
		});

		it("forgets a name when its window ends", async () => {
			const limiter = createRefreshLimiter();
			expect(limiter.claim("a", 0)).toBeUndefined();
			limiter.release("a");
			expect(limiter.claim("b", 61_000)).toBeUndefined();
			expect(limiter.size()).toBe(1);
		});
	});

	it("writes no value to the warnings", async () => {
		const kit = await makeKit();
		await kit.run();
		expect(kit.warnings.join("\n")).not.toContain(VALUE);
	});
});
