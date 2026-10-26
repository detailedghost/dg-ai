import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolveDgPaths, type DgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { phoneNumber, phoneOpen, phoneRefresh, phoneStatus, type OpenCloseDeps } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import { createFileKey, type KeyClient } from "../../src/phone/keys";
import {
	isZombieStat,
	keyFingerprint,
	listenerPidPath,
	listenerProcessAlive,
	readListenerPid,
} from "../../src/phone/listener";
import { writeListener } from "../../src/phone/store";
import { DG_AGENT_PACKAGE_VERSION } from "../../src/version";
import { makeHomeTracker, parseNdjson } from "./fake-pool";

let tracker: ReturnType<typeof makeHomeTracker>;
let out: string[];
const NOW = Math.floor(Date.now() / 1000);

function lines(): unknown[] {
	return parseNdjson(out);
}

type Harness = {
	deps: OpenCloseDeps;
	paths: DgPaths;
	killed: number[];
	spawned: number[];
	ran: string[][];
};

function harness(): Harness {
	const paths = resolveDgPaths({ env: { DG_HOME: tracker.freshHome() } });
	const db = PhoneDb.open(paths, () => NOW);
	tracker.trackDb(db);
	const killed: number[] = [];
	const spawned: number[] = [];
	const ran: string[][] = [];
	const installed = new Set<string>();
	const deps: OpenCloseDeps = {
		paths,
		db,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant");
		},
		createPool: () => {
			throw new Error("no pool");
		},
		write: (text) => out.push(text),
		readStdin: async () => undefined,
		now: () => NOW,
		platform: "linux",
		homeDir: "/home/u",
		env: {},
		uid: 501,
		writeFile: (path) => {
			installed.add(path);
		},
		removeFile: (path) => {
			installed.delete(path);
		},
		fileExists: (path) => installed.has(path),
		run: async (argv) => {
			ran.push(argv);
			return { code: 0, stdout: "", stderr: "" };
		},
		which: (name) => `/resolved/${name}`,
		listenerArgv: (extra) => ["/fake/dg-agent", "phone", "__run", ...extra],
		spawnListener: () => {
			const pid = 7000 + spawned.length;
			spawned.push(pid);
			return pid;
		},
		kill: (pid) => {
			killed.push(pid);
			rmSync(listenerPidPath(paths), { force: true });
		},
		isOurListener: () => true,
		sleep: async () => {},
	};
	return { deps, paths, killed, spawned, ran };
}

function writePid(paths: DgPaths, record: Record<string, unknown>): void {
	writeFileSync(listenerPidPath(paths), JSON.stringify({ since: NOW, hook: null, ...record }));
}

beforeEach(() => {
	tracker = makeHomeTracker("dg-phone-stale-");
	out = [];
});

afterEach(() => {
	tracker.cleanup();
});

describe("a listener whose keys drifted", () => {
	it("flags the drift from status and restarts it from open", async () => {
		const h = harness();
		const sk = createFileKey(h.deps.db, "default") as Uint8Array;
		const fingerprint = keyFingerprint([{ id: "default", pub: getPublicKey(sk) }]);
		writePid(h.paths, { pid: process.pid, version: DG_AGENT_PACKAGE_VERSION, keys: fingerprint });
		writeListener(h.deps.db, { autostart: { kind: "systemd" } });

		await phoneStatus(h.deps);
		expect(lines()[0]).toMatchObject({ listener: { pid: process.pid, stale: false }, notice: null, pending_voicemail: 0 });

		out = [];
		await phoneOpen({}, h.deps);
		expect(lines()[0]).toMatchObject({ status: "running", pid: process.pid });
		expect(h.killed).toEqual([]);

		h.deps.db.putKey({ id: "default", nsec: nip19.nsecEncode(generateSecretKey()), in_store: 0 });
		out = [];
		await phoneStatus(h.deps);
		expect(lines()[0]).toMatchObject({
			listener: { stale: true, reason: "listener keys differ from the database" },
			notice: "key changed",
			pending_voicemail: 0,
		});
		out = [];
		await phoneStatus(h.deps);
		expect(h.deps.db.unreadMessages().filter((row) => row.sender === "phone").map((row) => row.text)).toEqual(["key changed"]);

		out = [];
		h.ran.length = 0;
		await phoneOpen({}, h.deps);
		expect(h.killed).toEqual([process.pid]);
		expect(lines()[0]).toMatchObject({ status: "restarted" });
	});

	it("treats a missing binary version as stale and a dead pid as no listener", async () => {
		const h = harness();
		createFileKey(h.deps.db, "default");
		writePid(h.paths, { pid: process.pid, keys: "anything" });
		writeListener(h.deps.db, { autostart: { kind: "systemd" } });

		await phoneStatus(h.deps);
		expect(lines()[0]).toMatchObject({
			listener: { stale: true, reason: "listener binary version differs" },
			notice: "listener binary changed",
		});

		out = [];
		await phoneOpen({}, h.deps);
		expect(h.killed).toEqual([process.pid]);
		expect(lines()[0]).toMatchObject({ status: "restarted" });

		out = [];
		h.killed.length = 0;
		writePid(h.paths, { pid: 999_999_999, version: DG_AGENT_PACKAGE_VERSION });
		await phoneStatus(h.deps);
		expect(lines()[0]).toMatchObject({ listener: null });

		out = [];
		await phoneOpen({}, h.deps);
		expect(h.killed).toEqual([]);
		expect(lines()[0]).toMatchObject({ status: "started" });
	});

	it("does not restart when the keys cannot be read", async () => {
		const h = harness();
		writePid(h.paths, { pid: process.pid, version: DG_AGENT_PACKAGE_VERSION, keys: "abc" });
		writeListener(h.deps.db, { autostart: { kind: "systemd" } });
		const real = h.deps.db;
		h.deps.db = new Proxy(real, {
			get(target, prop, receiver) {
				if (prop === "listKeyIds") return () => { throw new Error("locked"); };
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		await phoneStatus(h.deps);
		expect(lines()[0]).toMatchObject({ listener: { stale: true, reason: "listener keys could not be read" }, notice: null });

		out = [];
		await phoneOpen({}, h.deps);
		expect(h.killed).toEqual([]);
		expect(lines()[0]).toMatchObject({ status: "running" });
	});
});

describe("zombie and dead pids", () => {
	it("treats stat state Z as dead and S as alive", () => {
		expect(isZombieStat("1 (phone) Z 0")).toBe(true);
		expect(isZombieStat("1 (phone) S 0")).toBe(false);
		expect(listenerProcessAlive(process.pid, () => "12 (dg-agent) Z 0")).toBe(false);
		expect(listenerProcessAlive(process.pid, () => "12 (dg-agent) S 0")).toBe(true);

		const h = harness();
		writePid(h.paths, { pid: process.pid, version: DG_AGENT_PACKAGE_VERSION });
		expect(readListenerPid(h.paths, () => listenerProcessAlive(process.pid, () => "12 (dg-agent) Z 0"))).toBeUndefined();
		expect(readListenerPid(h.paths, () => listenerProcessAlive(process.pid, () => "12 (dg-agent) S 0"))?.pid).toBe(process.pid);
	});
});

describe("the next writing command", () => {
	it("restarts a listener whose binary version differs", async () => {
		const h = harness();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
		const pid = child.pid;
		if (pid === undefined) throw new Error("helper did not start");
		try {
			writePid(h.paths, { pid });

			await phoneNumber({}, h.deps);

			expect(h.killed).toEqual([pid]);
			expect(h.spawned).toEqual([7000]);
		} finally {
			child.kill();
		}
	});
});

describe("phone __refresh", () => {
	it("does not create a phone when this install has never used one", async () => {
		const paths = resolveDgPaths({ env: { DG_HOME: tracker.freshHome() } });
		const deps = {
			paths,
			get db(): PhoneDb {
				throw new Error("opened phone.db");
			},
			isOurListener: () => true,
			kill: () => {},
			sleep: async () => {},
			spawnListener: () => 1,
			listenerArgv: () => [],
			run: async () => ({ code: 0, stdout: "", stderr: "" }),
			uid: 0,
		} as unknown as OpenCloseDeps;

		await phoneRefresh(deps);

		expect(existsSync(PhoneDb.path(paths))).toBe(false);
	});

	it("stops a detached listener whose version differs and starts one replacement", async () => {
		const h = harness();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
		const pid = child.pid;
		if (pid === undefined) throw new Error("helper did not start");
		try {
			writePid(h.paths, { pid, version: "1.19.1" });

			await phoneRefresh(h.deps);

			expect(h.killed).toEqual([pid]);
			expect(h.spawned).toEqual([7000]);
			expect(h.deps.db.unreadMessages().map((row) => row.text)).toEqual(["listener binary changed"]);
		} finally {
			child.kill();
		}
	});
});
