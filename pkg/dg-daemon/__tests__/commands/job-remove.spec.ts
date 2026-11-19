import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { writePidFileAtomic } from "@dg/common/node";
import { servicePidFile } from "../../src/services/supervisor";
import { freshTempDir } from "../utils/daemon-harness";
import { configPathOf } from "../utils/service-daemon";
import {
	homeTracker,
	jobsTable,
	pathsOf,
	postJob,
	readConfigFile,
	runCli,
	seedJobs,
	sleeperEntry,
} from "./job-cli-helpers";

const homes = homeTracker();
afterEach(() => homes.cleanup());

const readBytes = (dgHome: string) => readFileSync(configPathOf(dgHome), "utf8");

describe("job remove", () => {
	it("removes a stopped job and keeps the other entries", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
			keep: sleeperEntry(cwd),
		}));

		const result = await runCli(dgHome, ["job", "remove", "x"], { port });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('removed job "x"');
		expect(Object.keys(jobsTable(readConfigFile(dgHome)))).toEqual(["keep"]);
	});

	it("removes a job with no daemon running", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });

		const result = await runCli(dgHome, ["job", "remove", "x"]);

		expect(result.code).toBe(0);
		expect(jobsTable(readConfigFile(dgHome))).toEqual({});
	});

	it("refuses a running job and keeps the entry", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));
		expect((await postJob(port, "x", "start")).ok).toBe(true);
		const before = readBytes(dgHome);

		const result = await runCli(dgHome, ["job", "remove", "x"], { port });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job "x" is running');
		expect(result.stderr).toContain("dg job stop x");
		expect(readBytes(dgHome)).toBe(before);
	});

	it("refuses a job in backoff and keeps the entry", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: {
				continuous: true,
				argv: [process.execPath, "-e", "process.exit(1)"],
				cwd,
			},
		}));
		expect((await postJob(port, "x", "start")).ok).toBe(true);
		const before = readBytes(dgHome);
		let result = await runCli(dgHome, ["job", "remove", "x"], { port });
		for (let i = 0; i < 40 && !result.stderr.includes("is backoff"); i++) {
			await Bun.sleep(100);
			result = await runCli(dgHome, ["job", "remove", "x"], { port });
		}

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job "x" is backoff');
		expect(readBytes(dgHome)).toBe(before);
	});

	it("refuses when a daemon pid is alive and does not answer", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		writePidFileAtomic(pathsOf(dgHome), {
			pid: process.pid,
			port: 1,
			instanceId: crypto.randomUUID(),
			versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
		});
		const before = readBytes(dgHome);

		const result = await runCli(dgHome, ["job", "remove", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not answer");
		expect(readBytes(dgHome)).toBe(before);
	});

	it("refuses when the instance pid file names a live process", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const instance = servicePidFile(pathsOf(dgHome).daemonDir, "x");
		mkdirSync(dirname(instance), { recursive: true });
		writeFileSync(instance, String(process.pid));
		const before = readBytes(dgHome);

		const result = await runCli(dgHome, ["job", "remove", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`still runs as pid ${process.pid}`);
		expect(result.stderr).toContain(instance);
		expect(readBytes(dgHome)).toBe(before);
	});

	it("names an unknown job", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {});

		const result = await runCli(dgHome, ["job", "remove", "ghost"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
	});
});
