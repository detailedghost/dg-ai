import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AutostartDeps, type DgPaths, resolveDgPaths } from "@dg/common/node";
import {
	type ActiveDaemon,
	activeDaemonPath,
	readActiveDaemon,
	removeActiveDaemon,
	stopOtherDaemon,
	type SingleInstanceSeams,
	writeActiveDaemon,
} from "../../src/server/single-instance";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	spawnServe,
	waitForHealth,
	waitForPidFile,
} from "../utils/daemon-harness";

const homes: string[] = [];
const home = (): string => {
	const dir = freshDgHome();
	homes.push(dir);
	return dir;
};
const procs: ReturnType<typeof spawnServe>[] = [];
const serve = (dgHome: string, port: number, userHome: string): ReturnType<typeof spawnServe> => {
	const proc = spawnServe(dgHome, port, { DG_PATH_FENCE: "", HOME: userHome, USERPROFILE: userHome });
	procs.push(proc);
	return proc;
};
afterEach(async () => {
	for (const proc of procs.splice(0)) {
		proc.kill("SIGKILL");
		await proc.exited;
	}
	for (const dir of homes.splice(0)) cleanupDgHome(dir);
});

const unfenced = (root: string): SingleInstanceSeams => ({ env: {}, recordPath: join(root, "active-daemon.json") });
const pathsOf = (dgHome: string): DgPaths => resolveDgPaths({ env: { DG_HOME: dgHome } });

const recordOf = (dgHome: string, overrides: Partial<ActiveDaemon> = {}): ActiveDaemon => ({
	pid: 4242,
	port: 47001,
	instanceId: "other-instance",
	home: dgHome,
	stateDir: pathsOf(dgHome).stateDir,
	version: "1.0.0",
	...overrides,
});

const plant = (path: string, record: ActiveDaemon): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(record));
};

const noUnit: AutostartDeps = {
	platform: "linux",
	homeDir: "/nonexistent",
	env: {},
	uid: 1000,
	writeFile: () => {},
	removeFile: () => {},
	fileExists: () => false,
	run: async () => ({ code: 0, stdout: "", stderr: "" }),
};

describe("single-instance record path", () => {
	it("ignores DG_HOME and the fence when computing the user-level root", () => {
		const base = { HOME: "/home/someone", XDG_STATE_HOME: "/home/someone/state" };
		const plain = activeDaemonPath(base, "linux", "/home/someone");
		const withHome = activeDaemonPath(
			{ ...base, DG_HOME: "/tmp/other", DG_PATH_FENCE: "/tmp" },
			"linux",
			"/home/someone",
		);
		expect(withHome).toBe(plain);
		expect(plain).toBe("/home/someone/state/dg/daemon/active-daemon.json");
	});
});

describe("single-instance record", () => {
	it("writes the live daemon and removes it only while it still names this daemon", () => {
		const root = home();
		const seams = unfenced(root);
		const paths = pathsOf(home());
		writeActiveDaemon(paths, { pid: 11, port: 47002, instanceId: "mine", version: "9.9.9" }, seams);
		const record = readActiveDaemon(seams);
		expect(record).toMatchObject({ pid: 11, port: 47002, instanceId: "mine", stateDir: paths.stateDir, version: "9.9.9" });

		removeActiveDaemon({ pid: 11, instanceId: "someone-else" }, seams);
		expect(readActiveDaemon(seams)?.instanceId).toBe("mine");
		removeActiveDaemon({ pid: 11, instanceId: "mine" }, seams);
		expect(readActiveDaemon(seams)).toBeUndefined();
	});

	it("treats an unreadable record as absent", () => {
		const root = home();
		writeFileSync(join(root, "active-daemon.json"), "{not json");
		expect(readActiveDaemon(unfenced(root))).toBeUndefined();
	});
});

describe("stopOtherDaemon", () => {
	it("stops a live daemon of another home and prints one line on stderr", async () => {
		const root = home();
		const other = home();
		const mine = pathsOf(home());
		const seams = unfenced(root);
		plant(seams.recordPath as string, recordOf(other));
		const stopped: string[] = [];
		const lines: string[] = [];
		await stopOtherDaemon(mine, {
			...seams,
			isLive: async () => true,
			stop: async (paths) => void stopped.push(paths.stateDir),
			autostart: noUnit,
			warn: (line) => lines.push(line),
		});
		expect(stopped).toEqual([pathsOf(other).stateDir]);
		expect(lines).toEqual([`dg-daemon: stopped the daemon of ${other} (pid 4242, port 47001) so only one runs`]);
	});

	it("replaces a stale record without stopping anything", async () => {
		const root = home();
		const seams = unfenced(root);
		plant(seams.recordPath as string, recordOf(home()));
		const lines: string[] = [];
		await stopOtherDaemon(pathsOf(home()), {
			...seams,
			isLive: async () => false,
			stop: async () => {
				throw new Error("must not stop a stale record");
			},
			warn: (line) => lines.push(line),
		});
		expect(lines).toEqual([]);
	});

	it("leaves the daemon of the same home alone", async () => {
		const root = home();
		const same = home();
		const seams = unfenced(root);
		plant(seams.recordPath as string, recordOf(same));
		await stopOtherDaemon(pathsOf(same), {
			...seams,
			isLive: async () => true,
			stop: async () => {
				throw new Error("must not stop the same home");
			},
		});
	});

	it("reports instead of stopping a daemon that a login unit manages", async () => {
		const root = home();
		const other = home();
		const seams = unfenced(root);
		plant(seams.recordPath as string, recordOf(other));
		const lines: string[] = [];
		await stopOtherDaemon(pathsOf(home()), {
			...seams,
			isLive: async () => true,
			stop: async () => {
				throw new Error("must not fight the login unit");
			},
			autostart: { ...noUnit, fileExists: () => true, readFile: () => `Environment="DG_HOME=${other}"` },
			warn: (line) => lines.push(line),
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`the daemon of ${other} (pid 4242, port 47001)`);
		expect(lines[0]).toContain("systemd login unit");
	});

	it("never reads, writes or stops anything while the test fence is set", async () => {
		const seams: SingleInstanceSeams = { env: { DG_PATH_FENCE: "/tmp" }, recordPath: join(home(), "active-daemon.json") };
		const planted = recordOf(home());
		plant(seams.recordPath as string, planted);
		const before = readFileSync(seams.recordPath as string, "utf8");
		const mine = pathsOf(home());
		await stopOtherDaemon(mine, {
			...seams,
			isLive: async () => true,
			stop: async () => {
				throw new Error("a fenced serve must not stop anything");
			},
		});
		writeActiveDaemon(mine, { pid: 1, port: 2, instanceId: "fenced", version: "0" }, seams);
		removeActiveDaemon({ pid: planted.pid, instanceId: planted.instanceId }, seams);
		expect(readFileSync(seams.recordPath as string, "utf8")).toBe(before);
	});

	it("resolves the default record path under the fenced HOME, never a real user directory", () => {
		const root = home();
		expect(activeDaemonPath({ DG_PATH_FENCE: "/tmp" }, "linux", root).startsWith(root)).toBe(true);
	});
});

describe("two real daemons of different homes", () => {
	it("starts the second one and stops the first", async () => {
		const userHome = home();
		const homeA = home();
		const homeB = home();
		const portA = allocatePort();
		const a = serve(homeA, portA, userHome);
		await waitForHealth(portA);
		const handleA = await waitForPidFile(homeA);

		const portB = allocatePort();
		const b = serve(homeB, portB, userHome);
		const stderr = new Response(b.stderr).text();
		await waitForHealth(portB, 12_000);
		await a.exited;
		expect(handleA.port).toBe(portA);
		const handleB = await waitForPidFile(homeB);

		const userSeams: SingleInstanceSeams = { recordPath: activeDaemonPath({}, process.platform, userHome) };
		const record = readActiveDaemon(userSeams);
		expect(record).toMatchObject({ pid: handleB.pid, instanceId: handleB.instanceId, home: homeB });

		b.kill("SIGTERM");
		await b.exited;
		expect(readActiveDaemon(userSeams)).toBeUndefined();
		expect(await stderr).toContain(`dg-daemon: stopped the daemon of ${homeA} (pid ${handleA.pid}, port ${portA}) so only one runs`);
		expect(existsSync(pathsOf(homeA).pidPath)).toBe(false);
	}, 40_000);
});
