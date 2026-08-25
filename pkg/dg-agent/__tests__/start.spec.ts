import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	type DgCliError,
	EXIT_PROTOCOL_MISMATCH,
	EXIT_WSL_NAT_NETWORKING,
	validateSessionBootstrap,
} from "@dg/common";
import { resolveDgPaths, writePidFileAtomic } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByPidFile,
	readPidFile,
	registerSession,
	spawnServe,
	waitForHealth,
	waitForPidFile,
} from "@dg/dg-daemon/test-harness";
import { cmdStart, type StartSeams } from "../src/start";
import { runCli } from "./cli-wire";

const DAEMON_ENTRY = join(import.meta.dir, "../../dg-daemon/src/index.ts");

function sourceDaemonArgv(): string[] {
	return [process.execPath, DAEMON_ENTRY, "__serve"];
}

const startFromSource: StartSeams = { daemonArgv: sourceDaemonArgv };

async function withDgEnv<T>(
	vars: Record<string, string>,
	fn: () => Promise<T>,
): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(vars)) saved[key] = process.env[key];
	Object.assign(process.env, vars);
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function captureLogs(): { logs: string[]; restore: () => void } {
	const logs: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	};
	return {
		logs,
		restore: () => {
			console.log = original;
		},
	};
}

async function cmdStartFromSource(
	dgHome: string,
	port: number,
): Promise<string> {
	const capture = captureLogs();
	try {
		await withDgEnv(
			{ DG_HOME: dgHome, DG_PORT: String(port), DG_KEY_SOURCE: "file" },
			() => cmdStart({}, startFromSource),
		);
	} finally {
		capture.restore();
	}
	if (capture.logs.length !== 1) {
		throw new Error(
			`expected cmdStart to log exactly one line, got: ${capture.logs.join("\n")}`,
		);
	}
	return capture.logs[0];
}

describe("cmdStart — cold start", () => {
	let dgHome: string;
	let port: number;
	let url: string;

	afterAll(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	beforeAll(async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		url = await cmdStartFromSource(dgHome, port);
	}, 20_000);

	it("binds the fixed test port — a live /healthz responds", async () => {
		await waitForHealth(port);
	});

	it("writes a pid file with no token field at all", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const raw = JSON.parse(readFileSync(paths.pidPath, "utf8"));
		expect(Object.hasOwn(raw, "token")).toBe(false);
		const handle = readPidFile(dgHome);
		expect(handle.port).toBe(port);
	});

	it("prints a bootstrap URL whose fragment decodes to a valid session", () => {
		const bootstrap = validateSessionBootstrap(decodeChatMarker(url));
		expect(bootstrap.port).toBe(port);
		expect(bootstrap.sessionId.length).toBeGreaterThan(0);
		expect(bootstrap.token.length).toBeGreaterThan(0);
	});
});

describe("cmdStart — pid file reclaim", () => {
	it("reclaims a pid file whose daemon does not answer /healthz with a matching instance id", async () => {
		const dgHome = freshDgHome();
		const port = allocatePort();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				paths.pidPath,
				JSON.stringify({
					pid: 999_999,
					port,
					instanceId: "stale-instance-nobody-is-listening",
					versions: { package: "0.0.0", protocol: CHAT_PROTOCOL_VERSION },
				}),
			);

			await cmdStartFromSource(dgHome, port);

			const reclaimed = await waitForPidFile(dgHome);
			expect(reclaimed.instanceId).not.toBe(
				"stale-instance-nobody-is-listening",
			);
			expect(reclaimed.pid).not.toBe(999_999);
			await waitForHealth(port);
		} finally {
			killDaemonByPidFile(dgHome);
			cleanupDgHome(dgHome);
		}
	}, 20_000);
});

describe("a second dg-agent start on a live daemon", () => {
	let dgHome: string;
	let port: number;
	let firstHandle: ReturnType<typeof readPidFile>;
	let firstBootstrap: Awaited<ReturnType<typeof registerSession>>;
	let secondResult: Awaited<ReturnType<typeof runCli>>;

	afterAll(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	beforeAll(async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);
		firstBootstrap = await registerSession(port);
		firstHandle = readPidFile(dgHome);

		secondResult = await runCli(dgHome, port, ["start"]);
	}, 20_000);

	it("reuses the same daemon process rather than binding a second port", () => {
		expect(secondResult.exitCode).toBe(0);
		const secondHandle = readPidFile(dgHome);
		expect(secondHandle.instanceId).toBe(firstHandle.instanceId);
		expect(secondHandle.pid).toBe(firstHandle.pid);
	});

	it("registers a second session with its own distinct id and token", () => {
		const secondBootstrap = validateSessionBootstrap(
			decodeChatMarker(extractUrl(secondResult.stdout)),
		);
		expect(secondBootstrap.sessionId).not.toBe(firstBootstrap.sessionId);
		expect(secondBootstrap.token).not.toBe(firstBootstrap.token);
	});
});

describe("dg-agent start — protocol version mismatch on attach", () => {
	it("refuses to attach, names the remediation, and registers no new session", async () => {
		const dgHome = freshDgHome();
		const port = allocatePort();
		try {
			spawnServe(dgHome, port);
			await waitForHealth(port);

			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const handle = readPidFile(dgHome);
			writeFileSync(
				paths.pidPath,
				JSON.stringify({
					...handle,
					versions: {
						...handle.versions,
						protocol: handle.versions.protocol + 99,
					},
				}),
			);

			const result = await runCli(dgHome, port, ["start"]);

			expect(result.exitCode).toBe(EXIT_PROTOCOL_MISMATCH);
			expect(result.stderr).toContain("never auto-restarts a shared daemon");
			expect(result.stdout).not.toMatch(/https?:\/\//);
		} finally {
			killDaemonByPidFile(dgHome);
			cleanupDgHome(dgHome);
		}
	}, 20_000);
});

describe("cmdStart refuses before the daemon ever spawns on NAT-mode WSL", () => {
	it("exits WSL-NAT, prints the mirrored-mode remediation, and creates neither a pid file nor a daemon", async () => {
		const dgHome = freshDgHome();
		const port = allocatePort();
		try {
			const result = await runCli(dgHome, port, ["start"], {
				WSL_DISTRO_NAME: "test-distro",
				DG_WSL_NETWORKING_MODE: "nat",
			});

			expect(result.exitCode).toBe(EXIT_WSL_NAT_NETWORKING);
			expect(result.stderr).toContain(".wslconfig");
			expect(result.stderr).toContain("networkingMode=mirrored");

			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			expect(existsSync(paths.pidPath)).toBe(false);
			await expect(
				fetch(`http://127.0.0.1:${port}/healthz`, {
					headers: { Host: `127.0.0.1:${port}` },
					signal: AbortSignal.timeout(500),
				}),
			).rejects.toBeDefined();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});

describe("a daemon of another protocol", () => {
	const FIXTURE = join(import.meta.dir, "fixtures/mismatched-daemon.ts");

	async function mismatchFrom(
		dgHome: string,
		port: number,
	): Promise<DgCliError> {
		try {
			await withDgEnv(
				{ DG_HOME: dgHome, DG_PORT: String(port), DG_KEY_SOURCE: "file" },
				() =>
					cmdStart(
						{},
						{ daemonArgv: () => [process.execPath, FIXTURE, "__serve"] },
					),
			);
		} catch (err) {
			return err as DgCliError;
		}
		throw new Error("cmdStart resolved against a mismatched daemon");
	}

	it("is refused right after this command starts it, not at the first frame of a later one", async () => {
		const dgHome = freshDgHome();
		const port = allocatePort();
		const capture = captureLogs();
		try {
			const err = await mismatchFrom(dgHome, port);

			expect(err.exitCode).toBe(EXIT_PROTOCOL_MISMATCH);
			expect(err.message).toContain("another release");
			expect(err.message).toContain("dg-skills install");
			expect(capture.logs).toEqual([]);
		} finally {
			capture.restore();
			killDaemonByPidFile(dgHome);
			cleanupDgHome(dgHome);
		}
	}, 20_000);

	it("stops every other command at the pid file, instead of timing out on a frame", async () => {
		const dgHome = freshDgHome();
		const port = allocatePort();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			mkdirSync(paths.sessionsDir, { recursive: true });
			writeFileSync(
				join(paths.sessionsDir, "session-a.json"),
				JSON.stringify({
					sessionId: "session-a",
					token: "token-a",
					cwd: process.cwd(),
					agentIdentity: "alpha",
				}),
			);
			writePidFileAtomic(paths, {
				pid: process.pid,
				port,
				instanceId: "mismatched",
				versions: { package: "0.0.0", protocol: CHAT_PROTOCOL_VERSION + 99 },
			});

			const result = await runCli(dgHome, port, ["recv"]);

			expect(result.exitCode).toBe(EXIT_PROTOCOL_MISMATCH);
			expect(result.stderr).toContain("dg-skills install");
			expect(result.stderr).not.toContain("did not answer");
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
