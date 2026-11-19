import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialGrantTokenPath, jobStateDir } from "@dg/common/node";
import { parseJobEntry } from "../../src/jobs/config";
import {
	buildBaseEnv,
	buildJobEnv,
	jobLogFile,
	launchJob,
} from "../../src/jobs/launcher";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function kit() {
	const root = mkdtempSync(join(tmpdir(), "dg-launcher-"));
	roots.push(root);
	const warns: string[] = [];
	const deps = {
		paths: {
			daemonDir: join(root, "daemon"),
			logDir: join(root, "logs"),
			grantsDir: join(root, "grants"),
			jobStateRoot: join(root, "state", "jobs"),
		},
		daemonUrl: () => "http://127.0.0.1:4242",
		logger: { info: () => {}, warn: (message: string) => warns.push(message) },
		maxLogBytes: 1_000_000,
	};
	return { root, deps, warns };
}

function declOf(root: string, extra: Record<string, unknown> = {}) {
	const parsed = parseJobEntry("bot", {
		argv: [process.execPath, "-e", "0"],
		cwd: root,
		continuous: true,
		...extra,
	});
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed;
}

function withProcessEnv<T>(vars: Record<string, string>, run: () => T): T {
	for (const [key, value] of Object.entries(vars)) process.env[key] = value;
	try {
		return run();
	} finally {
		for (const key of Object.keys(vars)) delete process.env[key];
	}
}

const passEnvWarning = (name: string) =>
	`service bot: passEnv name ${name} is not set in the daemon environment`;

describe("jobLogFile", () => {
	it("keeps the service-<name>.log path", () => {
		expect(jobLogFile("/l", "bot")).toBe(join("/l", "service-bot.log"));
	});
});

describe("buildBaseEnv", () => {
	it("copies a passEnv name, withholds other daemon variables and adds no DG_SERVICE keys", () => {
		const { root, deps } = kit();
		const env = withProcessEnv(
			{ DG_TEST_PASS: "from-daemon", DG_TEST_OTHER: "leak" },
			() => buildBaseEnv(declOf(root, { passEnv: ["DG_TEST_PASS"] }), deps),
		);
		expect(env.DG_TEST_PASS).toBe("from-daemon");
		expect(env.DG_TEST_OTHER).toBeUndefined();
		expect(
			Object.keys(env).filter((key) => key.startsWith("DG_SERVICE")),
		).toEqual([]);
	});

	it("lets an envFile value win over a passEnv name and over an allowlisted name", () => {
		const { root, deps } = kit();
		const envFile = join(root, "secrets.env");
		writeFileSync(envFile, "DG_TEST_PASS=from-file\nLANG=from-file\n", {
			mode: 0o600,
		});
		const env = withProcessEnv({ DG_TEST_PASS: "from-daemon" }, () =>
			buildBaseEnv(declOf(root, { passEnv: ["DG_TEST_PASS"], envFile }), deps),
		);
		expect(env.DG_TEST_PASS).toBe("from-file");
		expect(env.LANG).toBe("from-file");
	});

	it("warns once with the exact text for a missing passEnv name and never prints a value", () => {
		const { root, deps, warns } = kit();
		delete process.env.DG_TEST_ABSENT;
		withProcessEnv({ DG_TEST_PASS: "s3cret-value" }, () =>
			buildBaseEnv(
				declOf(root, { passEnv: ["DG_TEST_PASS", "DG_TEST_ABSENT"] }),
				deps,
			),
		);
		expect(warns).toEqual([passEnvWarning("DG_TEST_ABSENT")]);
		expect(warns.join("\n")).not.toContain("s3cret-value");
	});

	it("copies an empty passEnv value and logs no warning", () => {
		const { root, deps, warns } = kit();
		const env = withProcessEnv({ DG_TEST_EMPTY: "" }, () =>
			buildBaseEnv(declOf(root, { passEnv: ["DG_TEST_EMPTY"] }), deps),
		);
		expect(env.DG_TEST_EMPTY).toBe("");
		expect(warns).toEqual([]);
	});
});

describe("buildJobEnv", () => {
	it("adds the injected DG keys after the base", () => {
		const { root, deps } = kit();
		const env = buildJobEnv(declOf(root), deps);
		expect(env).toMatchObject({
			DG_SERVICE_API: "1",
			DG_SERVICE_LABEL: "bot",
			DG_DAEMON_URL: deps.daemonUrl(),
			DG_SERVICE_STATE_DIR: jobStateDir(deps.paths, "bot"),
		});
	});

	it("lets the injected keys win over an envFile that sets them", () => {
		const { root, deps } = kit();
		const envFile = join(root, "e.env");
		writeFileSync(
			envFile,
			"DG_SERVICE_LABEL=forged\nDG_DAEMON_URL=http://evil\nDG_CREDENTIAL_GRANT_PREFIX=other\n",
			{ mode: 0o600 },
		);
		const env = buildJobEnv(declOf(root, { envFile }), deps);
		expect(env.DG_SERVICE_LABEL).toBe("bot");
		expect(env.DG_DAEMON_URL).toBe(deps.daemonUrl());
		expect(env.DG_CREDENTIAL_GRANT_PREFIX).toBeUndefined();
		expect(env.DG_CREDENTIAL_GRANT_FILE).toBeUndefined();
	});

	it("sets the grant prefix and token file for a job with a grant", () => {
		const { root, deps } = kit();
		const env = buildJobEnv(declOf(root, { grant: "bot" }), deps);
		expect(env.DG_CREDENTIAL_GRANT_PREFIX).toBe("bot");
		expect(env.DG_CREDENTIAL_GRANT_FILE).toBe(
			credentialGrantTokenPath(deps.paths, "bot"),
		);
	});

	it("passes DG_HOME through when the daemon has it", () => {
		const { root, deps } = kit();
		const env = withProcessEnv({ DG_HOME: "/some/home" }, () =>
			buildJobEnv(declOf(root), deps),
		);
		expect(env.DG_HOME).toBe("/some/home");
	});

	it("keeps the same order as the base for passEnv, envFile, then injected keys", () => {
		const { root, deps } = kit();
		const envFile = join(root, "e.env");
		writeFileSync(envFile, "DG_TEST_PASS=from-file\n", { mode: 0o600 });
		const env = withProcessEnv({ DG_TEST_PASS: "from-daemon" }, () =>
			buildJobEnv(declOf(root, { passEnv: ["DG_TEST_PASS"], envFile }), deps),
		);
		expect(env.DG_TEST_PASS).toBe("from-file");
		expect(env.DG_SERVICE_LABEL).toBe("bot");
	});
});

describe("launchJob without a supervisor", () => {
	it("spawns the argv in the cwd with the job env and writes the output to the log", async () => {
		const { root, deps } = kit();
		const dump = join(root, "env.json");
		const decl = declOf(root, {
			argv: [
				process.execPath,
				"-e",
				`require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ env: process.env, cwd: process.cwd() })); console.log("hello-log");`,
			],
			passEnv: ["DG_TEST_PASS"],
		});
		const proc = withProcessEnv({ DG_TEST_PASS: "yes" }, () =>
			launchJob(decl, deps),
		);
		await proc.exited;
		const seen = JSON.parse(readFileSync(dump, "utf8"));
		expect(seen.env.DG_TEST_PASS).toBe("yes");
		expect(seen.env.DG_SERVICE_LABEL).toBe("bot");
		expect(seen.cwd).toBe(root);
		const log = jobLogFile(deps.paths.logDir, "bot");
		expect(readFileSync(log, "utf8")).toContain("hello-log");
		if (process.platform !== "win32") {
			expect(statSync(log).mode & 0o777).toBe(0o600);
		}
	});

	it("appends to an existing log and rotates one that is above maxLogBytes", async () => {
		const { root, deps } = kit();
		const log = jobLogFile(deps.paths.logDir, "bot");
		mkdirSync(deps.paths.logDir, { recursive: true });
		writeFileSync(log, "x".repeat(200));
		const small = { ...deps, maxLogBytes: 100 };
		const proc = launchJob(
			declOf(root, {
				argv: [process.execPath, "-e", 'console.log("fresh")'],
			}),
			small,
		);
		await proc.exited;
		expect(readFileSync(log, "utf8")).toBe("fresh\n");
		expect(existsSync(`${log}.1`)).toBe(true);
	});

	it("throws and does not leave a spawned process when the command cannot run", () => {
		const { root, deps } = kit();
		expect(() =>
			launchJob(declOf(root, { argv: [join(root, "missing-binary")] }), deps),
		).toThrow();
	});
});
