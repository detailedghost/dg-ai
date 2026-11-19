import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CHAT_SERVICES_PATH, describeError } from "@dg/common";
import { ensurePrivateDir, resolveDgPaths } from "@dg/common/node";
import { servicePidFile } from "../../src/services/supervisor";
import { runCli } from "../commands/service-cli-helpers";
import {
	bootServe,
	cleanupDgHome,
	createCleanupSlot,
	freshTempDir,
	ownerTokenHeader,
	stopServe,
	waitForPidFile,
} from "../utils/daemon-harness";
import { configPathOf, writeConfigFile } from "../utils/service-daemon";
import {
	disposeRigs,
	type Kit,
	type Rig,
	rig,
	SLEEPER,
	until,
	withDaemonEnv,
} from "./supervisor-kit";

afterEach(disposeRigs);
const cleanupSlot = createCleanupSlot();
afterEach(() => cleanupSlot.run());

const posixOnly = process.platform === "win32" ? it.skip : it;

function dumpScript(kit: Kit, dump: string): string[] {
	return kit.script(
		`const fs = require("node:fs");
		const dir = process.env.DG_SERVICE_STATE_DIR;
		let mode = null;
		let exists = false;
		try { mode = fs.statSync(dir).mode & 0o777; exists = true; } catch {}
		fs.appendFileSync(${JSON.stringify(dump)}, JSON.stringify({ env: process.env, mode, exists }) + "\\n");
		${SLEEPER}`,
	);
}

type Dumped = {
	env: Record<string, string>;
	mode: number | null;
	exists: boolean;
};

function readDumps(file: string): Dumped[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Dumped);
}

function dumpRig(
	extra: Record<string, unknown> = {},
	labels: string[] = ["bot"],
): { r: Rig; dump: string } {
	const r = rig((kit) =>
		Object.fromEntries(
			labels.map((label) => [
				label,
				{
					argv: dumpScript(kit, join(kit.root, "dump.jsonl")),
					cwd: kit.root,
					...extra,
				},
			]),
		),
	);
	return { r, dump: join(r.root, "dump.jsonl") };
}

const stateDirOf = (r: Rig, label = "bot") => join(r.jobStateRoot, label);

describe("supervisor state folder environment", () => {
	it("gives each service its own DG_SERVICE_STATE_DIR under the job state root", async () => {
		const { r, dump } = dumpRig({}, ["bot", "worker"]);
		expect(r.supervisor.start("bot").ok).toBe(true);
		expect(r.supervisor.start("worker").ok).toBe(true);
		await until(() => readDumps(dump).length === 2);

		const byLabel = new Map(
			readDumps(dump).map((entry) => [entry.env.DG_SERVICE_LABEL, entry]),
		);
		for (const label of ["bot", "worker"]) {
			expect(byLabel.get(label)?.env.DG_SERVICE_STATE_DIR).toBe(
				stateDirOf(r, label),
			);
			expect(byLabel.get(label)?.exists).toBe(true);
		}
	});

	posixOnly(
		"makes the state folder with mode 0700 before the child starts",
		async () => {
			const { r, dump } = dumpRig();
			r.supervisor.start("bot");
			await until(() => readDumps(dump).length === 1);

			const [seen] = readDumps(dump);
			expect(seen.mode).toBe(0o700);
			expect(statSync(stateDirOf(r)).mode & 0o777).toBe(0o700);
		},
	);

	it("lets the daemon value win over envFile and passEnv for DG_SERVICE_STATE_DIR", async () => {
		let envFile = "";
		let dump = "";
		const r = rig((kit) => {
			dump = join(kit.root, "dump.jsonl");
			envFile = join(kit.root, "secrets.env");
			writeFileSync(envFile, "DG_SERVICE_STATE_DIR=/from/envfile\n", {
				mode: 0o600,
			});
			return {
				bot: {
					argv: dumpScript(kit, dump),
					cwd: kit.root,
					envFile,
					passEnv: ["DG_SERVICE_STATE_DIR"],
				},
			};
		});
		await withDaemonEnv({ DG_SERVICE_STATE_DIR: "/from/daemon" }, async () => {
			expect(r.supervisor.start("bot").ok).toBe(true);
			await until(() => readDumps(dump).length === 1);
		});

		expect(readDumps(dump)[0].env.DG_SERVICE_STATE_DIR).toBe(stateDirOf(r));
	});

	it("keeps the pid file and the log file where they were", async () => {
		const { r, dump } = dumpRig();
		r.supervisor.start("bot");
		await until(() => readDumps(dump).length === 1);

		const daemonDir = join(r.root, "daemon");
		expect(servicePidFile(daemonDir, "bot")).toBe(
			join(daemonDir, "services", "bot.pid"),
		);
		expect(existsSync(join(daemonDir, "services", "bot.pid"))).toBe(true);
		expect(r.logFile).toBe(join(r.root, "logs", "service-bot.log"));
		expect(existsSync(r.logFile)).toBe(true);
		expect(existsSync(join(stateDirOf(r), "bot.pid"))).toBe(false);
	});

	it("accepts a state folder that already holds a file and leaves the file unchanged", async () => {
		const { r, dump } = dumpRig();
		const dir = stateDirOf(r);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		const file = join(dir, "import.json");
		writeFileSync(file, '{"imported":true}\n');
		const before = statSync(file).mtimeMs;

		expect(r.supervisor.start("bot").ok).toBe(true);
		await until(() => readDumps(dump).length === 1);

		expect(readFileSync(file, "utf8")).toBe('{"imported":true}\n');
		expect(statSync(file).mtimeMs).toBe(before);
	});

	it("does not delete the state folder on stop", async () => {
		const { r, dump } = dumpRig();
		r.supervisor.start("bot");
		await until(() => readDumps(dump).length === 1);
		const marker = join(stateDirOf(r), "keep.txt");
		writeFileSync(marker, "x");

		await r.supervisor.stop("bot");

		expect(existsSync(marker)).toBe(true);
	});

	it("restarts a crashed child with the same DG_SERVICE_STATE_DIR and DG_HOME", async () => {
		let dump = "";
		const r = rig((kit) => {
			dump = join(kit.root, "dump.jsonl");
			const counter = join(kit.root, "runs");
			return {
				bot: {
					argv: kit.script(
						`const fs = require("node:fs");
						fs.appendFileSync(${JSON.stringify(dump)}, JSON.stringify({ env: process.env }) + "\\n");
						fs.appendFileSync(${JSON.stringify(counter)}, "x");
						if (fs.readFileSync(${JSON.stringify(counter)}, "utf8").length === 1) process.exit(1);
						${SLEEPER}`,
					),
					cwd: kit.root,
				},
			};
		});
		await withDaemonEnv({ DG_HOME: "/d-crash" }, async () => {
			expect(r.supervisor.start("bot").ok).toBe(true);
			await until(() => readDumps(dump).length === 2);
		});

		const [first, second] = readDumps(dump);
		expect(second.env.DG_SERVICE_STATE_DIR).toBe(stateDirOf(r));
		expect(second.env.DG_SERVICE_STATE_DIR).toBe(
			first.env.DG_SERVICE_STATE_DIR,
		);
		expect(second.env.DG_HOME).toBe("/d-crash");
		expect(second.env.DG_HOME).toBe(first.env.DG_HOME);
	});
});

describe("supervisor DG_HOME for children", () => {
	it("passes the daemon DG_HOME and lets no envFile line override it", async () => {
		let dump = "";
		const r = rig((kit) => {
			dump = join(kit.root, "dump.jsonl");
			const envFile = join(kit.root, "secrets.env");
			writeFileSync(envFile, "DG_HOME=/x\n", { mode: 0o600 });
			return { bot: { argv: dumpScript(kit, dump), cwd: kit.root, envFile } };
		});
		await withDaemonEnv({ DG_HOME: "/d" }, async () => {
			expect(r.supervisor.start("bot").ok).toBe(true);
			await until(() => readDumps(dump).length === 1);
		});

		expect(readDumps(dump)[0].env.DG_HOME).toBe("/d");
	});

	it("adds no DG_HOME when the daemon has none", async () => {
		const { r, dump } = dumpRig();
		const saved = process.env.DG_HOME;
		delete process.env.DG_HOME;
		try {
			expect(r.supervisor.start("bot").ok).toBe(true);
			await until(() => readDumps(dump).length === 1);
		} finally {
			if (saved !== undefined) process.env.DG_HOME = saved;
		}

		expect(Object.hasOwn(readDumps(dump)[0].env, "DG_HOME")).toBe(false);
	});
});

const asFile = (path: string) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "not a folder");
};
const reasonFor = (path: string): string => {
	try {
		ensurePrivateDir(path);
	} catch (err) {
		return describeError(err);
	}
	throw new Error("ensurePrivateDir did not throw");
};

describe("supervisor state folder preflight", () => {
	it("returns invalid with the create text when the job state root is a regular file", () => {
		const { r, dump } = dumpRig();
		asFile(r.jobStateRoot);

		const result = r.supervisor.start("bot");

		const path = stateDirOf(r);
		expect(result).toEqual({
			ok: false,
			kind: "invalid",
			error: `cannot create the state folder ${path}: ${reasonFor(path)}`,
		});
		expect(existsSync(dump)).toBe(false);
		expect(existsSync(r.logFile)).toBe(false);
		expect(r.status().state).toBe("stopped");
		expect(r.supervisor.runningCount()).toBe(0);
	});

	posixOnly("refuses a job state folder that is a symbolic link and leaves its target alone", () => {
		const { r, dump } = dumpRig();
		const target = join(dirname(dump), "elsewhere");
		mkdirSync(target, { recursive: true, mode: 0o755 });
		mkdirSync(r.jobStateRoot, { recursive: true });
		const path = stateDirOf(r);
		symlinkSync(target, path);

		const result = r.supervisor.start("bot");

		expect(result).toEqual({
			ok: false,
			kind: "invalid",
			error: `cannot create the state folder ${path}: it is a symbolic link`,
		});
		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(existsSync(dump)).toBe(false);
		expect(r.supervisor.runningCount()).toBe(0);
	});

	posixOnly("refuses a dangling link at the job state folder and creates nothing behind it", () => {
		const { r, dump } = dumpRig();
		const target = join(dirname(dump), "not-yet");
		mkdirSync(r.jobStateRoot, { recursive: true });
		const path = stateDirOf(r);
		symlinkSync(target, path);

		const result = r.supervisor.start("bot");

		expect(result).toEqual({
			ok: false,
			kind: "invalid",
			error: `cannot create the state folder ${path}: it is a symbolic link`,
		});
		expect(existsSync(target)).toBe(false);
		expect(r.supervisor.runningCount()).toBe(0);
	});

	const canTestPermission =
		process.platform !== "win32" && process.getuid?.() !== 0;
	(canTestPermission ? it : it.skip)(
		"returns invalid with the create text when the job state root has no write permission",
		() => {
			const { r, dump } = dumpRig();
			mkdirSync(r.jobStateRoot, { recursive: true });
			chmodSync(r.jobStateRoot, 0o500);
			try {
				const result = r.supervisor.start("bot");

				const path = stateDirOf(r);
				expect(result.ok).toBe(false);
				expect(result.ok === false && result.kind).toBe("invalid");
				expect(result.ok === false && result.error).toBe(
					`cannot create the state folder ${path}: ${reasonFor(path)}`,
				);
				expect(existsSync(dump)).toBe(false);
			} finally {
				chmodSync(r.jobStateRoot, 0o700);
			}
		},
	);

	it("reports a missing cwd before the state folder problem", () => {
		const { r } = dumpRig({ cwd: "/nonexistent-dg-cwd" });
		asFile(r.jobStateRoot);

		const result = r.supervisor.start("bot");

		expect(result).toEqual({
			ok: false,
			kind: "invalid",
			error: "cwd does not exist: /nonexistent-dg-cwd",
		});
	});

	it("reports a missing grant token before the state folder problem", () => {
		const { r } = dumpRig({ grant: "bot" });
		asFile(r.jobStateRoot);

		const result = r.supervisor.start("bot");

		expect(result.ok === false && result.error).toStartWith(
			"grant token file not found: ",
		);
	});
});

describe("state folder against a live daemon", () => {
	async function boot() {
		const { dgHome, port, proc } = await bootServe();
		cleanupSlot.set(async () => {
			await stopServe(proc);
			cleanupDgHome(dgHome);
		});
		await waitForPidFile(dgHome);
		return {
			dgHome,
			port,
			paths: resolveDgPaths({ env: { DG_HOME: dgHome } }),
		};
	}

	const post = (port: number, path: string) =>
		fetch(`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}/${path}`, {
			method: "POST",
			headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
		});

	const sleeper = (cwd: string) => ({
		argv: [process.execPath, "-e", "setTimeout(() => {}, 600000)"],
		cwd,
	});

	it("answers HTTP 400 with the create text and starts no process", async () => {
		const { dgHome, port, paths } = await boot();
		writeConfigFile(dgHome, { services: { bot: sleeper(dgHome) } });
		rmSync(paths.jobStateRoot, { recursive: true, force: true });
		mkdirSync(paths.stateDir, { recursive: true });
		writeFileSync(paths.jobStateRoot, "not a folder");
		const path = join(paths.jobStateRoot, "bot");

		const response = await post(port, "bot/start");

		expect(response.status).toBe(400);
		expect(await response.text()).toBe(
			`cannot create the state folder ${path}: ${reasonFor(path)}`,
		);
		const status = (await (
			await fetch(`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}`, {
				headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
			})
		).json()) as {
			services: Array<{ label: string; state: string; pid: number | null }>;
		};
		expect(status.services.find((s) => s.label === "bot")).toMatchObject({
			state: "stopped",
			pid: null,
		});
	});

	it("gives a service from service add its state folder and the daemon DG_HOME, and keeps the folder after stop and rm", async () => {
		const { dgHome, port, paths } = await boot();
		const cwd = freshTempDir("svc-state-cwd");
		const dump = join(cwd, "dump.jsonl");
		const script = join(cwd, "dump.js");
		writeFileSync(
			script,
			`require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ env: process.env })); setTimeout(() => {}, 600000);`,
		);
		writeConfigFile(dgHome, { pinnedOrigin: "p", services: {} });

		const added = await runCli(
			dgHome,
			["service", "add", "bot", "--cwd", cwd, "--", process.execPath, script],
			{ port },
		);
		expect(added.code).toBe(0);
		expect(existsSync(configPathOf(dgHome))).toBe(true);
		expect((await post(port, "bot/start")).ok).toBe(true);
		await until(() => existsSync(dump));

		const { env } = JSON.parse(readFileSync(dump, "utf8")) as Dumped;
		const stateDir = join(paths.jobStateRoot, "bot");
		expect(env.DG_SERVICE_STATE_DIR).toBe(stateDir);
		expect(env.DG_HOME).toBe(dgHome);
		expect(existsSync(stateDir)).toBe(true);

		expect((await post(port, "bot/stop")).ok).toBe(true);
		const removed = await runCli(dgHome, ["service", "rm", "bot"], { port });
		expect(removed.code).toBe(0);
		expect(existsSync(stateDir)).toBe(true);
	});
});
