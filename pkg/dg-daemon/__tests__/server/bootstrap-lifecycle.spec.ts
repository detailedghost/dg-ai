import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	CHAT_PROTOCOL_VERSION,
	EXIT_PROTOCOL_MISMATCH,
	validateSessionBootstrap,
} from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByPidFile,
	readPidFile,
	runStart,
	waitForHealth,
	waitForPidFile,
} from "../utils/daemon-harness";

describe("dg-daemon start — cold start", () => {
	let dgHome: string;
	let port: number;
	let result: Awaited<ReturnType<typeof runStart>>;

	afterAll(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	beforeAll(async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		result = await runStart(dgHome, port);
	});

	it("binds the fixed test port — a live /healthz responds", async () => {
		await waitForHealth(port);
	});

	it("writes a pid file with no token field at all", async () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const raw = JSON.parse(readFileSync(paths.pidPath, "utf8"));
		expect(Object.hasOwn(raw, "token")).toBe(false);
		const handle = readPidFile(dgHome);
		expect(handle.port).toBe(port);
	});

	it("prints a bootstrap URL whose fragment decodes to a valid session", () => {
		const url = extractUrl(result.stdout);
		const decoded = decodeChatMarker(url);
		const bootstrap = validateSessionBootstrap(decoded);
		expect(bootstrap.port).toBe(port);
		expect(bootstrap.sessionId.length).toBeGreaterThan(0);
		expect(bootstrap.token.length).toBeGreaterThan(0);
	});
});

describe("GET /start", () => {
	let dgHome: string;
	let port: number;
	let firstBootstrapUrl: string;

	afterAll(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	beforeAll(async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		const result = await runStart(dgHome, port);
		firstBootstrapUrl = extractUrl(result.stdout);
		await waitForHealth(port);
	});

	it("carries no session data in its response body", async () => {
		const bootstrap = validateSessionBootstrap(
			decodeChatMarker(firstBootstrapUrl),
		);
		const resp = await fetch(`http://127.0.0.1:${port}/start`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.text();
		expect(body).not.toContain(bootstrap.sessionId);
		expect(body).not.toContain(bootstrap.token);
	});
});

describe("a second dg-daemon start on a live daemon", () => {
	let dgHome: string;
	let port: number;
	let firstHandle: ReturnType<typeof readPidFile>;
	let firstBootstrap: ReturnType<typeof validateSessionBootstrap>;
	let secondResult: Awaited<ReturnType<typeof runStart>>;

	afterAll(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	beforeAll(async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		const first = await runStart(dgHome, port);
		await waitForHealth(port);
		firstHandle = readPidFile(dgHome);
		firstBootstrap = validateSessionBootstrap(
			decodeChatMarker(extractUrl(first.stdout)),
		);

		secondResult = await runStart(dgHome, port);
	});

	it("reuses the same daemon process rather than binding a second port", () => {
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

describe("pid file reclaim", () => {
	let dgHome: string;
	let port: number;

	afterEach(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	it("reclaims a pid file whose daemon does not answer /healthz with a matching instance id", async () => {
		dgHome = freshDgHome();
		port = allocatePort();
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

		await runStart(dgHome, port);
		const reclaimed = await waitForPidFile(dgHome);

		expect(reclaimed.instanceId).not.toBe("stale-instance-nobody-is-listening");
		expect(reclaimed.pid).not.toBe(999_999);
		await waitForHealth(port);
		const health = await (
			await fetch(`http://127.0.0.1:${port}/healthz`, {
				headers: { Host: `127.0.0.1:${port}` },
			})
		).json();
		expect(health.instanceId).toBe(reclaimed.instanceId);
	});
});

describe("dg-daemon start — protocol version mismatch on attach", () => {
	let dgHome: string;
	let port: number;

	afterEach(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	it("refuses to attach, names the remediation, and registers no new session", async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		await runStart(dgHome, port);
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

		const result = await runStart(dgHome, port);

		expect(result.exitCode).toBe(EXIT_PROTOCOL_MISMATCH);
		expect(result.stderr).toContain("never auto-restarts a shared daemon");
		expect(result.stdout).not.toMatch(/https?:\/\//);
	});
});
