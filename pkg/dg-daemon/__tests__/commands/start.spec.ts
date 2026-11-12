import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
	CHAT_PROTOCOL_VERSION,
	type DaemonHandle,
	EXIT_WSL_NAT_NETWORKING,
} from "@dg/common";
import { resolveDgPaths, writePidFileAtomic } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	ENTRY,
	freshDgHome,
	killDaemonByPidFile,
	readPidFile,
	subprocessEnv,
	waitForDaemonExit,
	waitForHealth,
} from "../utils/daemon-harness";

type RunResult = { code: number; stdout: string; stderr: string };

async function dg(
	dgHome: string,
	port: number,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<RunResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
		env: subprocessEnv(dgHome, port, extraEnv),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

type StartJson = {
	started: boolean;
	pid: number;
	port: number;
	version: string;
};

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function homeWithPort() {
	const dgHome = freshDgHome();
	const port = allocatePort();
	cleanups.push(async () => {
		killDaemonByPidFile(dgHome);
		await waitForDaemonExit(dgHome).catch(() => {});
		cleanupDgHome(dgHome);
	});
	return { dgHome, port };
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("dg-daemon start", () => {
	it("starts a daemon on a new home and reports it with --json", async () => {
		const { dgHome, port } = homeWithPort();

		const result = await dg(dgHome, port, ["start", "--json"]);

		expect(result.code).toBe(0);
		expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
		const report = JSON.parse(result.stdout) as StartJson;
		expect(report.started).toBe(true);
		expect(report.port).toBe(port);
		expect(report.pid).toBe(readPidFile(dgHome).pid);
		expect(report.version).toBe(readPidFile(dgHome).versions.package);
		await waitForHealth(report.port);
	});

	it("does not start a second daemon and reports the same pid and port", async () => {
		const { dgHome, port } = homeWithPort();
		const first = JSON.parse(
			(await dg(dgHome, port, ["start", "--json"])).stdout,
		) as StartJson;

		const second = await dg(dgHome, port, ["start", "--json"]);

		expect(second.code).toBe(0);
		const report = JSON.parse(second.stdout) as StartJson;
		expect(report).toEqual({ ...first, started: false });
		expect(readPidFile(dgHome).pid).toBe(first.pid);
		expect(pidAlive(first.pid)).toBe(true);
	});

	it("prints the started line, then the already running line", async () => {
		const { dgHome, port } = homeWithPort();

		const first = await dg(dgHome, port, ["start"]);
		const handle = readPidFile(dgHome);
		const where = `127.0.0.1:${port} (pid ${handle.pid}, version ${handle.versions.package})`;
		expect(first.code).toBe(0);
		expect(first.stdout).toBe(`dg-daemon started on ${where}\n`);

		const second = await dg(dgHome, port, ["start"]);
		expect(second.code).toBe(0);
		expect(second.stdout).toBe(`dg-daemon already running on ${where}\n`);
	});

	it("starts a new daemon when the pid file names a dead process", async () => {
		const { dgHome, port } = homeWithPort();
		const dead: DaemonHandle = {
			pid: 2_147_483_000,
			port: allocatePort(),
			instanceId: "dead-instance",
			versions: { package: "0.0.1", protocol: CHAT_PROTOCOL_VERSION },
		};
		writePidFileAtomic(resolveDgPaths({ env: { DG_HOME: dgHome } }), dead);

		const result = await dg(dgHome, port, ["start", "--json"]);

		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout) as StartJson;
		expect(report.started).toBe(true);
		expect(report.pid).not.toBe(dead.pid);
		expect(report.port).toBe(port);
	});

	it("reports already running for a live daemon of another protocol, with no protocol check", async () => {
		const dgHome = freshDgHome();
		cleanups.push(() => cleanupDgHome(dgHome));
		const instanceId = crypto.randomUUID();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ instanceId }),
		});
		cleanups.push(() => server.stop(true));
		const handle: DaemonHandle = {
			pid: process.pid,
			port: server.port as number,
			instanceId,
			versions: { package: "1.2.3", protocol: CHAT_PROTOCOL_VERSION + 1 },
		};
		writePidFileAtomic(resolveDgPaths({ env: { DG_HOME: dgHome } }), handle);

		const result = await dg(dgHome, 0, ["start"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			`dg-daemon already running on 127.0.0.1:${handle.port} (pid ${handle.pid}, version 1.2.3)\n`,
		);
	});

	for (const args of [["start"], ["start", "--json"]]) {
		it(`exits ${EXIT_WSL_NAT_NETWORKING} on WSL NAT mode with no stdout, no pid file and no daemon (${args.join(" ")})`, async () => {
			const { dgHome, port } = homeWithPort();

			const result = await dg(dgHome, port, args, {
				WSL_DISTRO_NAME: "Ubuntu",
				DG_WSL_NETWORKING_MODE: "nat",
			});

			expect(result.code).toBe(EXIT_WSL_NAT_NETWORKING);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(".wslconfig");
			expect(
				existsSync(resolveDgPaths({ env: { DG_HOME: dgHome } }).pidPath),
			).toBe(false);
			expect(
				await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined),
			).toBeUndefined();
		});
	}

	for (const args of [["start"], ["start", "--json"]]) {
		it(`exits 1 on the startup timeout with no stdout (${args.join(" ")})`, async () => {
			const { dgHome, port } = homeWithPort();
			const blocker = Bun.serve({
				hostname: "127.0.0.1",
				port,
				fetch: () => new Response("busy"),
			});
			cleanups.push(() => blocker.stop(true));

			const result = await dg(dgHome, port, args);

			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				"dg-daemon did not become healthy within the startup timeout",
			);
		}, 30_000);
	}
});
