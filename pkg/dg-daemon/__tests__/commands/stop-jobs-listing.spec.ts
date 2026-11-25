import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHAT_JOBS_PATH,
	CHAT_PROTOCOL_VERSION,
	DgCliError,
} from "@dg/common";
import {
	type AutostartDeps,
	ensureOwnerToken,
	resolveDgPaths,
	writePidFileAtomic,
} from "@dg/common/node";
import { cmdStop } from "../../src/commands/stop";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const cleanups: Array<() => void> = [];
const savedHome = process.env.DG_HOME;
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	if (savedHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = savedHome;
});

const inertAutostart: AutostartDeps = {
	platform: "linux",
	homeDir: join(tmpdir(), "dg-stop-jobs-no-unit"),
	env: {},
	uid: 1000,
	writeFile: () => {},
	removeFile: () => {},
	fileExists: () => false,
	run: async (argv) => {
		throw new Error(`unexpected manager command: ${argv.join(" ")}`);
	},
};

type Route = (instanceId: string) => Response | Promise<Response>;

function setup(
	daemonPid: number,
	routes: Record<string, Route>,
): { requests: string[]; paths: ReturnType<typeof resolveDgPaths> } {
	const dgHome = freshDgHome();
	cleanups.push(() => cleanupDgHome(dgHome));
	process.env.DG_HOME = dgHome;
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const instanceId = crypto.randomUUID();
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			requests.push(path);
			if (path === "/healthz") return Response.json({ instanceId });
			const route = routes[path];
			return route ? route(instanceId) : new Response("none", { status: 404 });
		},
	});
	cleanups.push(() => server.stop(true));
	ensureOwnerToken(paths);
	writePidFileAtomic(paths, {
		pid: daemonPid,
		port: server.port as number,
		instanceId,
		versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
	});
	return { requests, paths };
}

function fakeProcessTable(alive: number[]) {
	const table = new Set(alive);
	const signals: number[] = [];
	const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
		const target = Math.abs(pid);
		if (!table.has(target))
			throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		if (signal !== 0) {
			signals.push(target);
			table.delete(target);
		}
	};
	const exec = (_command: string, args: string[]): void => {
		table.delete(Number(args[args.length - 1]));
	};
	return { kill, exec, signals };
}

const seams = (table: ReturnType<typeof fakeProcessTable>, extra = {}) => ({
	platform: "linux" as const,
	kill: table.kill,
	exec: table.exec,
	autostart: inertAutostart,
	waitMs: 1000,
	...extra,
});

const rejection = async (run: () => Promise<unknown>) =>
	run().then(
		() => undefined,
		(error: unknown) => error,
	);

describe("dg daemon stop --force job listing", () => {
	it("lists with /jobs, reads body.jobs and does not call /services", async () => {
		const table = fakeProcessTable([424242, 424243]);
		const { requests } = setup(424242, {
			[CHAT_JOBS_PATH]: (instanceId) =>
				Response.json({ instanceId, jobs: [{ label: "a", pid: 424243 }] }),
		});
		await cmdStop({ force: true }, seams(table));
		expect(table.signals).toEqual(expect.arrayContaining([424242, 424243]));
		expect(requests.filter((path) => path !== "/healthz")).toEqual([CHAT_JOBS_PATH]);
	});

	it("ignores a services key in the /jobs answer", async () => {
		const table = fakeProcessTable([424242, 424243]);
		setup(424242, {
			[CHAT_JOBS_PATH]: (instanceId) =>
				Response.json({ instanceId, services: [{ label: "a", pid: 424243 }] }),
		});
		const failure = await rejection(() => cmdStop({ force: true }, seams(table)));
		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as Error).message).toContain("could not list the services (");
	});

	it.each([
		["no instanceId", () => Response.json({ jobs: [{ label: "a", pid: 1 }] })],
		[
			"another instanceId",
			() => Response.json({ instanceId: "other", jobs: [{ label: "a", pid: 1 }] }),
		],
	])("names the failure when /jobs answers with %s and asks /services for nothing", async (_name, answer) => {
		const table = fakeProcessTable([424242]);
		const { requests } = setup(424242, { [CHAT_JOBS_PATH]: answer });
		const failure = await rejection(() => cmdStop({ force: true }, seams(table)));
		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as Error).message).toContain("the answer is not from this daemon instance");
		expect(requests).not.toContain("/services");
	});

	it("names the failure after a 404 on /jobs and asks /services for nothing", async () => {
		const table = fakeProcessTable([424242]);
		const { requests } = setup(424242, {});
		const failure = await rejection(() => cmdStop({ force: true }, seams(table)));
		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as Error).message).toContain("could not list the services (404");
		expect(requests).not.toContain("/services");
	});

	it("names the failure when /jobs answers 403", async () => {
		const table = fakeProcessTable([424242]);
		setup(424242, {
			[CHAT_JOBS_PATH]: () => new Response("forbidden", { status: 403 }),
		});
		const failure = await rejection(() => cmdStop({ force: true }, seams(table)));
		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as Error).message).toContain("could not list the services (403");
	});

	it("names the failure on a network error", async () => {
		const table = fakeProcessTable([424242]);
		setup(424242, {
			[CHAT_JOBS_PATH]: () => new Promise<Response>(() => {}),
		});
		const failure = await rejection(() =>
			cmdStop({ force: true }, seams(table, { listTimeoutMs: 100 })),
		);
		expect(failure).toBeInstanceOf(DgCliError);
	});
});

describe("dg daemon stop --force with real processes", () => {
	it("ends the daemon and each job process tree", async () => {
		const spawnSleeper = () => {
			const proc = Bun.spawn(
				[process.execPath, "-e", "setInterval(() => {}, 1000)"],
				{ stdout: "ignore", stderr: "ignore", detached: true },
			);
			cleanups.push(() => proc.kill("SIGKILL"));
			return proc;
		};
		const daemon = spawnSleeper();
		const services = [spawnSleeper(), spawnSleeper()];
		setup(daemon.pid, {
			[CHAT_JOBS_PATH]: (instanceId) =>
				Response.json({
					instanceId,
					jobs: services.map((service, index) => ({
						label: `svc${index}`,
						pid: service.pid,
					})),
				}),
		});
		await cmdStop({ force: true }, { autostart: inertAutostart, waitMs: 5000 });
		await Promise.all([daemon.exited, ...services.map((s) => s.exited)]);
		for (const proc of [daemon, ...services]) {
			expect(() => process.kill(proc.pid, 0)).toThrow();
		}
	}, 20_000);
});

