import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHAT_JOBS_PATH,
	clearNotedSecrets,
	DG_CHROME_EXTENSION_ORIGIN,
	jobCredentialsPath,
	redactText,
	SERVICE_API_CREDENTIALS_PATH,
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
} from "@dg/common";
import { credentialGrantTokenPath, resolveDgPaths } from "@dg/common/node";
import { DispatchScheduler } from "../../src/dispatch";
import { type JobDecl, parseJobEntry } from "../../src/jobs/config";
import {
	buildBaseEnv,
	buildJobEnv,
	launchJob,
	startJobRun,
} from "../../src/jobs/launcher";
import { createJobRunner } from "../../src/jobs/runner";
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
import { rig, until } from "../services/supervisor-kit";

const VALUE = "tok-alpha-91f3c2d8";
const NEWER = "tok-bravo-5a07e1b4";
const MISSING = "credential api-key is missing — run dg job setup bot";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	clearNotedSecrets();
});

function kit(values: Record<string, string | undefined> = { "poll/api-key": VALUE }) {
	const root = mkdtempSync(join(tmpdir(), "dg-launcher-credential-env-"));
	roots.push(root);
	const reads: string[] = [];
	const deps = {
		paths: {
			daemonDir: join(root, "daemon"),
			logDir: join(root, "logs"),
			grantsDir: join(root, "grants"),
			jobsDir: join(root, "jobs"),
			jobSourcesPath: join(root, "jobs", "sources.json"),
			jobStateRoot: join(root, "state", "jobs"),
		},
		daemonUrl: () => "http://127.0.0.1:4242",
		logger: { info: () => {}, warn: () => {} },
		maxLogBytes: 1_000_000,
		readCredential: (name: string) => {
			reads.push(name);
			return values[name];
		},
	};
	return { root, deps, reads };
}

function declOf(root: string, extra: Record<string, unknown> = {}): JobDecl {
	const parsed = parseJobEntry(
		"bot",
		Object.fromEntries(
			Object.entries({
				argv: [process.execPath, "-e", "0"],
				cwd: root,
				continuous: true,
				grant: "poll",
				credentials: ["api-key"],
				credentialEnv: { API_KEY: "api-key" },
				...extra,
			}).filter(([, value]) => value !== undefined),
		),
	);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed;
}

const dumpEnv = (file: string, name = "API_KEY") =>
	`require("node:fs").writeFileSync(${JSON.stringify(file)}, process.env.${name} ?? "<unset>")`;

describe("buildJobEnv with a bound credential", () => {
	it("starts with the stored value under the bound name", () => {
		const { root, deps } = kit();
		expect(buildJobEnv(declOf(root), deps).API_KEY).toBe(VALUE);
	});

	it("reads the store name <grant>/<credential name> and no other", () => {
		const { root, deps, reads } = kit();
		buildJobEnv(declOf(root), deps);
		expect(reads).toEqual(["poll/api-key"]);
	});

	it("wins over a line of envFile, over passEnv and over the allowlist", () => {
		const { root, deps } = kit();
		const envFile = join(root, "bot.env");
		writeFileSync(envFile, "API_KEY=x\nTERM=from-file\n", { mode: 0o600 });
		const earlier = process.env.API_KEY;
		process.env.API_KEY = "from-daemon";
		try {
			const env = buildJobEnv(
				declOf(root, { envFile, passEnv: ["API_KEY"] }),
				deps,
			);
			expect(env.API_KEY).toBe(VALUE);
			expect(env.TERM).toBe("from-file");
		} finally {
			if (earlier === undefined) delete process.env.API_KEY;
			else process.env.API_KEY = earlier;
		}
	});

	it("keeps the injected DG_ keys after the bound values", () => {
		const { root, deps } = kit();
		const env = buildJobEnv(declOf(root), deps);
		expect(env.DG_SERVICE_LABEL).toBe("bot");
		expect(env.DG_CREDENTIAL_GRANT_PREFIX).toBe("poll");
		expect(Object.keys(env).indexOf("API_KEY")).toBeLessThan(
			Object.keys(env).indexOf("DG_SERVICE_API"),
		);
	});

	it("leaves buildBaseEnv with no bound value and reads no credential", () => {
		const { root, deps, reads } = kit();
		const base = buildBaseEnv(declOf(root), deps);
		expect(Object.values(base)).not.toContain(VALUE);
		expect(base.API_KEY).toBeUndefined();
		expect(reads).toEqual([]);
	});

	it("reads only the credentials the job binds", () => {
		const { root, deps, reads } = kit({
			"poll/api-key": VALUE,
			"poll/other": NEWER,
		});
		const env = buildJobEnv(
			declOf(root, { credentials: ["api-key", "other"] }),
			deps,
		);
		expect(reads).toEqual(["poll/api-key"]);
		expect(Object.values(env)).not.toContain(NEWER);
	});

	it("gives noteSecret each bound value", () => {
		const { root, deps } = kit({ "poll/api-key": VALUE, "poll/other": NEWER });
		buildJobEnv(
			declOf(root, {
				credentials: ["api-key", "other"],
				credentialEnv: { API_KEY: "api-key", OTHER: "other" },
			}),
			deps,
		);
		const text = redactText(`line ${VALUE} and ${NEWER} end`);
		expect(text).not.toContain(VALUE);
		expect(text).not.toContain(NEWER);
	});

	it("throws the is missing text for a credential that went away, with no value in it", () => {
		const { root, deps } = kit({});
		expect(() => buildJobEnv(declOf(root), deps)).toThrow(MISSING);
	});

	it("names the credential and not the value when the value holds a NUL byte", () => {
		const bad = `${VALUE}\0tail`;
		const { root, deps } = kit({ "poll/api-key": bad });
		let text = "";
		try {
			buildJobEnv(declOf(root), deps);
		} catch (err) {
			text = (err as Error).message;
		}
		expect(text).toBe("credential api-key cannot be an environment variable");
		expect(text).not.toContain("tok-alpha");
		expect(text).not.toContain("tail");
	});

	it("gives the storage text when the store throws", () => {
		const { root, deps } = kit();
		const failing = {
			...deps,
			readCredential: () => {
				throw new Error("credential store is locked");
			},
		};
		expect(() => buildJobEnv(declOf(root), failing)).toThrow(
			"credential store is locked",
		);
	});

	it.each(["pw", "PW", "db", "extension"])(
		"refuses the reserved grant %s before any store read",
		(grant) => {
			const { root, deps, reads } = kit({ [`${grant}/github.com`]: VALUE });
			const decl = {
				...declOf(root),
				grant,
				credentials: ["github.com"],
				credentialEnv: { TOKEN: "github.com" },
			};
			expect(() => buildJobEnv(decl, deps)).toThrow(/reserved/);
			expect(reads).toEqual([]);
		},
	);

	it("adds nothing for a job with no credentialEnv", () => {
		const { root, deps, reads } = kit();
		const env = buildJobEnv(
			declOf(root, { credentialEnv: undefined }),
			deps,
		);
		expect(reads).toEqual([]);
		expect(env.API_KEY).toBeUndefined();
	});
});

describe("launchJob and startJobRun with a bound credential", () => {
	it("gives a continuous child the value", async () => {
		const { root, deps } = kit();
		const out = join(root, "out.txt");
		const decl = declOf(root, { argv: [process.execPath, "-e", dumpEnv(out)] });
		const proc = launchJob(decl, deps);
		await proc.exited;
		expect(readFileSync(out, "utf8")).toBe(VALUE);
	});

	it("gives a scheduled child the value and writes no value of its own to the log", async () => {
		const { root, deps } = kit();
		const out = join(root, "out.txt");
		const decl = declOf(root, {
			continuous: undefined,
			every: "15m",
			argv: [process.execPath, "-e", dumpEnv(out)],
		});
		const run = startJobRun(decl, deps);
		await run.done;
		expect(readFileSync(out, "utf8")).toBe(VALUE);
		expect(readFileSync(join(deps.paths.logDir, "service-bot.log"), "utf8")).not.toContain(
			VALUE,
		);
	});

	it("throws before it starts a process for a credential that went away", () => {
		const { root, deps } = kit({});
		const out = join(root, "out.txt");
		const decl = declOf(root, { argv: [process.execPath, "-e", dumpEnv(out)] });
		expect(() => launchJob(decl, deps)).toThrow(MISSING);
		expect(() => startJobRun(decl, deps)).toThrow(MISSING);
		expect(existsSync(deps.paths.logDir)).toBe(false);
	});
});

describe("the supervisor with a bound credential", () => {
	const bot = (values: Record<string, string | undefined>, read?: () => never) => {
		const r = rig(
			({ root, script }) => ({
				bot: {
					argv: script(dumpEnv(join(root, "out.txt"))),
					cwd: root,
					stopTimeoutMs: 500,
					grant: "poll",
					credentials: ["api-key"],
					credentialEnv: { API_KEY: "api-key" },
				},
			}),
			60_000,
			{ readCredential: read ?? ((name) => values[name]) },
		);
		mkdirSync(join(r.root, "grants"), { recursive: true });
		writeFileSync(
			credentialGrantTokenPath({ grantsDir: join(r.root, "grants") }, "poll"),
			"token\n",
			{ mode: 0o600 },
		);
		return r;
	};

	it("refuses the start as invalid with the is missing text when the credential is absent", () => {
		const result = bot({}).supervisor.start("bot");
		expect(result).toEqual({ ok: false, kind: "invalid", error: MISSING });
	});

	it("refuses the start as invalid with the storage text when the store throws", () => {
		const r = bot({}, () => {
			throw new Error("credential store is locked");
		});
		const result = r.supervisor.start("bot");
		expect(result).toMatchObject({ ok: false, kind: "invalid" });
		expect((result as { error: string }).error).toContain("credential store is locked");
	});

	it("refuses the start as invalid when the value holds a NUL byte", () => {
		const result = bot({ "poll/api-key": `${VALUE}\0` }).supervisor.start("bot");
		expect(result).toEqual({
			ok: false,
			kind: "invalid",
			error: "credential api-key cannot be an environment variable",
		});
	});

	it("starts a job whose credential is present and hands it the value", async () => {
		const r = bot({ "poll/api-key": VALUE });
		expect(r.supervisor.start("bot").ok).toBe(true);
		await until(() => existsSync(join(r.root, "out.txt")));
		await until(() => readFileSync(join(r.root, "out.txt"), "utf8") === VALUE);
		await r.supervisor.stopAll();
		expect(r.infos.join("\n") + r.warns.join("\n")).not.toContain(VALUE);
	});
});

describe("the runner with a bound credential", () => {
	async function withRunner(
		values: Record<string, string | undefined>,
		run: (ctx: {
			root: string;
			dgHome: string;
			store: ChatStore;
			table: Record<string, Record<string, unknown>>;
			runner: ReturnType<typeof createJobRunner>;
			warns: string[];
		}) => Promise<void>,
	) {
		const dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		const table: Record<string, Record<string, unknown>> = {};
		const warns: string[] = [];
		const runner = createJobRunner({
			store,
			scheduler: new DispatchScheduler(),
			logger: { info: () => {}, warn: (m) => warns.push(m) },
			loadConfig: () => ({ jobsVersion: 2, jobs: table }),
			launcher: {
				paths,
				daemonUrl: () => "http://127.0.0.1:1",
				logger: { warn: () => {} },
				maxLogBytes: 1_000_000,
				readCredential: (name) => values[name],
			},
		});
		try {
			await run({ root: dgHome, dgHome, store, table, runner, warns });
		} finally {
			await runner.stopAll();
			store.close();
			cleanupDgHome(dgHome);
		}
	}

	const scheduledEntry = (argv: string[], cwd: string) => ({
		argv,
		cwd,
		every: "15m",
		enabled: true,
		grant: "poll",
		credentials: ["api-key"],
		credentialEnv: { API_KEY: "api-key" },
	});

	it("gives a scheduled run the bound variable", async () => {
		await withRunner({ "poll/api-key": VALUE }, async (ctx) => {
			const out = join(ctx.root, "out.txt");
			ctx.table.bot = scheduledEntry([process.execPath, "-e", dumpEnv(out)], ctx.root);
			const result = ctx.runner.runNow("bot");
			expect(result.ok).toBe(true);
			await until(() => {
				try {
					return readFileSync(out, "utf8") === VALUE;
				} catch {
					return false;
				}
			});
		});
	});

	it("gives invalid with the is missing text from runNow for a missing credential", async () => {
		await withRunner({}, async (ctx) => {
			const out = join(ctx.root, "out.txt");
			ctx.table.bot = scheduledEntry([process.execPath, "-e", dumpEnv(out)], ctx.root);
			const result = ctx.runner.runNow("bot");
			expect(result).toMatchObject({ ok: false, kind: "invalid" });
			expect((result as { error: string }).error).toContain(MISSING);
			expect(() => readFileSync(out, "utf8")).toThrow();
		});
	});

	it("records a failed run with the is missing text and starts no process", async () => {
		await withRunner({ "poll/other": VALUE }, async (ctx) => {
			const out = join(ctx.root, "out.txt");
			ctx.table.bot = scheduledEntry([process.execPath, "-e", dumpEnv(out)], ctx.root);
			const job = ctx.store.insertJobState({
				label: "bot",
				cwd: ctx.root,
				intervalMs: 900_000,
				nextRunAt: "2020-01-01T00:00:00.000Z",
			});
			const [outcome] = await Promise.all(ctx.runner.tick());
			expect(outcome?.error).toContain("is missing");
			expect(outcome?.error).not.toContain(VALUE);
			expect(ctx.store.getJob(job.id)?.lastError).toContain("is missing");
			expect(ctx.store.getJob(job.id)?.lastError).not.toContain(VALUE);
			expect(() => readFileSync(out, "utf8")).toThrow();
		});
	});
});

describe("a daemon with a bound credential", () => {
	type Boot = Awaited<ReturnType<typeof bootServe>>;
	let daemon: Boot;
	let out: string;
	const seen: string[] = [];

	const entry = (extra: Record<string, unknown> = {}) => ({
		argv: [
			process.execPath,
			"-e",
			`${dumpEnv(out)};setInterval(() => {}, 1000)`,
		],
		cwd: daemon.dgHome,
		continuous: true,
		grant: "poll",
		credentials: ["api-key"],
		credentialEnv: { API_KEY: "api-key" },
		...extra,
	});

	const paths = () => resolveDgPaths({ env: { DG_HOME: daemon.dgHome } });

	beforeAll(async () => {
		daemon = await bootServe();
		out = join(daemon.dgHome, "out.txt");
		writeFileSync(paths().daemonConfigPath, JSON.stringify({ jobs: { poll: entry() } }));
	});

	afterAll(async () => {
		await stopServe(daemon.proc);
		killDaemonByPidFile(daemon.dgHome);
		cleanupDgHome(daemon.dgHome);
		removeScratchDirs();
	});

	afterEach(async () => {
		await verb("poll", "stop");
		await credentialOp({ operation: "delete", name: "poll/api-key" });
		writeFileSync(paths().daemonConfigPath, JSON.stringify({ jobs: { poll: entry() } }));
	});

	const verb = async (name: string, action: "start" | "stop") => {
		const response = await fetch(
			`http://127.0.0.1:${daemon.port}${CHAT_JOBS_PATH}/${name}/${action}`,
			{
				method: "POST",
				headers: {
					Host: `127.0.0.1:${daemon.port}`,
					Origin: DG_CHROME_EXTENSION_ORIGIN,
				},
			},
		);
		const text = await response.text();
		seen.push(text);
		return { status: response.status, text };
	};

	const credentialOp = async (body: Record<string, unknown>) => {
		const response = await fetch(
			`http://127.0.0.1:${daemon.port}${jobCredentialsPath("poll")}`,
			{
				method: "POST",
				headers: {
					...ownerTokenHeader(daemon.port),
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			},
		);
		seen.push(await response.clone().text());
		return response;
	};

	const seedCredential = async (value: string) => {
		await credentialOp({ operation: "ensure-grant" });
		await credentialOp({ operation: "set", name: "poll/api-key", value });
	};

	it("answers 400 with the is missing text on the start route and starts no process", async () => {
		await credentialOp({ operation: "ensure-grant" });
		const result = await verb("poll", "start");
		expect(result.status).toBe(400);
		expect(result.text).toContain("credential api-key is missing — run dg job setup poll");
		expect(() => readFileSync(out, "utf8")).toThrow();
	});

	it("starts with the value, and a relaunch after the value changes has the new one", async () => {
		await credentialOp({ operation: "set", name: "poll/api-key", value: VALUE });
		expect((await verb("poll", "start")).status).toBe(200);
		await until(() => {
			try {
				return readFileSync(out, "utf8") === VALUE;
			} catch {
				return false;
			}
		});
		await verb("poll", "stop");
		rmSync(out);
		await credentialOp({ operation: "set", name: "poll/api-key", value: NEWER });
		expect((await verb("poll", "start")).status).toBe(200);
		await until(() => {
			try {
				return readFileSync(out, "utf8") === NEWER;
			} catch {
				return false;
			}
		});
		await verb("poll", "stop");
	});

	it("still returns the bound credential through service API v1", async () => {
		await seedCredential(NEWER);
		const token = readFileSync(credentialGrantTokenPath(paths(), "poll"), "utf8").trim();
		const response = await fetch(
			`http://127.0.0.1:${daemon.port}${SERVICE_API_CREDENTIALS_PATH}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					[CLI_GRANT_PREFIX_HEADER]: "poll",
					[CLI_GRANT_TOKEN_HEADER]: token,
				},
				body: JSON.stringify({ operation: "get", name: "poll/api-key" }),
			},
		);
		expect(response.status).toBe(200);
		expect(JSON.stringify(await response.json())).toContain(NEWER);
	});

	it("shows the value in no job status row, no daemon log line and no route answer", async () => {
		await seedCredential(VALUE);
		expect((await verb("poll", "start")).status).toBe(200);
		await until(() => {
			try {
				return readFileSync(out, "utf8") === VALUE;
			} catch {
				return false;
			}
		});
		await verb("poll", "stop");
		const status = await fetch(`http://127.0.0.1:${daemon.port}${CHAT_JOBS_PATH}`, {
			headers: {
				Host: `127.0.0.1:${daemon.port}`,
				Origin: DG_CHROME_EXTENSION_ORIGIN,
			},
		});
		const text = await status.text();
		for (const value of [VALUE, NEWER]) {
			expect(text).not.toContain(value);
			expect(readDaemonLog(daemon.dgHome)).not.toContain(value);
			expect(seen.join("\n")).not.toContain(value);
		}
	});

	it("keeps the stored credential after the entry goes and starts no process for it", async () => {
		await seedCredential(NEWER);
		writeFileSync(paths().daemonConfigPath, JSON.stringify({ jobs: {} }));
		expect((await verb("poll", "start")).status).toBe(404);
		const token = readFileSync(credentialGrantTokenPath(paths(), "poll"), "utf8").trim();
		const response = await fetch(
			`http://127.0.0.1:${daemon.port}${SERVICE_API_CREDENTIALS_PATH}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					[CLI_GRANT_PREFIX_HEADER]: "poll",
					[CLI_GRANT_TOKEN_HEADER]: token,
				},
				body: JSON.stringify({ operation: "get", name: "poll/api-key" }),
			},
		);
		expect(response.status).toBe(200);
	});
});
