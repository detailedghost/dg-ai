import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, type DaemonHandle } from "../src/chat-format";
import { resolveDgPaths } from "../src/node/dg-paths";
import {
	readPidFile,
	resolveLiveDaemon,
	writePidFileAtomic,
} from "../src/node/pidfile";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function setup() {
	const home = mkdtempSync(join(tmpdir(), "dg-pidfile-"));
	homes.push(home);
	const paths = resolveDgPaths({ env: { DG_HOME: home } });
	const logs: string[] = [];
	const spy = spyOn(console, "log").mockImplementation(
		(line: string) => void logs.push(line),
	);
	return { paths, logs, restore: () => spy.mockRestore() };
}

const handleFor = (
	port: number,
	pid: number,
	instanceId = "abc",
): DaemonHandle => ({
	pid,
	port,
	instanceId,
	versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
});

const alive = () => {};
const dead = () => {
	throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
};

describe("resolveLiveDaemon", () => {
	it("reports no live daemon when there is no pid file", async () => {
		const { paths, logs, restore } = setup();
		expect(await resolveLiveDaemon(paths)).toBeUndefined();
		restore();
		expect(logs).toEqual(["dg-daemon: no live daemon"]);
	});

	it("removes the pid file of a dead pid and says so", async () => {
		const { paths, logs, restore } = setup();
		writePidFileAtomic(paths, handleFor(1, 424242));
		expect(await resolveLiveDaemon(paths, dead)).toBeUndefined();
		restore();
		expect(logs).toEqual([
			"dg-daemon: no live daemon (stale pid file removed)",
		]);
		expect(existsSync(paths.pidPath)).toBe(false);
	});

	it("keeps the pid file and flags the handle when the pid is alive but healthz does not answer", async () => {
		const { paths, logs, restore } = setup();
		const handle = handleFor(1, 424242);
		writePidFileAtomic(paths, handle);
		expect(await resolveLiveDaemon(paths, alive)).toEqual({
			handle,
			live: false,
		});
		restore();
		expect(logs).toEqual([]);
		expect(readPidFile(paths)).toEqual(handle);
	});

	it("returns a live handle when healthz answers with the recorded instance id", async () => {
		const { paths, restore } = setup();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ instanceId: "abc" }),
		});
		const handle = handleFor(server.port as number, 424242);
		writePidFileAtomic(paths, handle);
		try {
			expect(await resolveLiveDaemon(paths, alive)).toEqual({
				handle,
				live: true,
			});
		} finally {
			restore();
			server.stop(true);
		}
	});
});
