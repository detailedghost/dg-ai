import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { writePidFileAtomic } from "@dg/common/node";
import { freshTempDir } from "../utils/daemon-harness";
import {
	homeTracker,
	lines,
	pathsOf,
	runCli,
	runCliWithoutDgHome,
	seedJobs,
	sleeperEntry,
	writeLog,
} from "./job-cli-helpers";

const homes = homeTracker();
afterEach(() => homes.cleanup());

const homeLines = (stderr: string) =>
	lines(stderr).filter((line) => line.startsWith("dg home:"));

describe("the dg home line of the job group", () => {
	it("prints dg home and daemon not running one time on stderr for each verb", async () => {
		const dgHome = homes.fresh();
		const cwd = freshTempDir("job-cwd");
		seedJobs(dgHome, { x: sleeperEntry(cwd, { enabled: true }) });
		writeLog(dgHome, "x", "one\n");
		const verbs = [
			["job", "list"],
			["job", "list", "--json"],
			["job", "status"],
			["job", "logs", "x"],
			["job", "logs", "ghost"],
			["job", "start", "x"],
			["job", "stop", "x"],
			["job", "restart", "x"],
			["job", "update", "x", "--every", "1m"],
			["job", "disable", "x"],
			["job", "remove", "x"],
			["job", "add", "--name", "y", "--continuous", "--cwd", cwd, "--", process.execPath, "-e", "1"],
		];

		for (const args of verbs) {
			const result = await runCli(dgHome, args);

			expect(homeLines(result.stderr)).toEqual([
				`dg home: ${dgHome}; daemon: not running`,
			]);
			expect(result.stdout).not.toContain("dg home:");
		}
	});

	it("names the URL of a live daemon", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));

		const result = await runCli(dgHome, ["job", "list"], { port });

		expect(homeLines(result.stderr)).toEqual([
			`dg home: ${dgHome}; daemon: http://127.0.0.1:${port}`,
		]);
	});

	it("keeps the line and the verb when the health call fails", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		writePidFileAtomic(pathsOf(dgHome), {
			pid: process.pid,
			port: 1,
			instanceId: crypto.randomUUID(),
			versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
		});

		const result = await runCli(dgHome, ["job", "list"]);

		expect(result.code).toBe(0);
		expect(homeLines(result.stderr)).toEqual([
			`dg home: ${dgHome}; daemon: not running`,
		]);
	});

	it("says default when DG_HOME is not set", async () => {
		const result = await runCliWithoutDgHome(["job", "list"], homes.fresh());

		expect(homeLines(result.stderr)).toHaveLength(1);
		expect(homeLines(result.stderr)[0].startsWith("dg home: default")).toBe(true);
		expect(result.stdout).not.toContain("dg home:");
	});

	it("is printed by job list, and the service group is an unknown command", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {});

		const job = await runCli(dgHome, ["job", "list"]);
		const service = await runCli(dgHome, ["service", "status"]);

		expect(homeLines(job.stderr)).toHaveLength(1);
		expect(service.code).toBe(1);
		expect(service.stderr).toContain("error: unknown command 'service'");
		expect(service.stderr).not.toContain("dg home:");
	});
});
