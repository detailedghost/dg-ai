import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { launchdPlistText, systemdUnitText, windowsTaskXml } from "../../src/phone/autostart";
import { type OpenCloseDeps, phoneRefresh } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import { listenerArgvFor, listenerPidPath } from "../../src/phone/listener";
import { createFileKey, readFileKey } from "../../src/phone/keys";
import {
	movePhoneState,
	rollbackPhoneState,
} from "../../src/phone/migrate-home";

let dir: string;
let oldRoot: string;
let newRoot: string;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

function seedPhone(root: string): Uint8Array {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const db = PhoneDb.openAt(join(root, "phone.db"), root);
	const key = createFileKey(db, "number");
	db.close();
	writeFileSync(join(root, "listener.log"), "listening\n", { mode: 0o600 });
	if (!key) throw new Error("no file key");
	return key;
}

function keyAt(root: string): Uint8Array | undefined {
	const db = PhoneDb.openAt(join(root, "phone.db"), root);
	try {
		return readFileKey(db, "number");
	} finally {
		db.close();
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-phone-move-"));
	oldRoot = join(dir, "old", "phone");
	newRoot = join(dir, "new", "state", "phone");
	lines.length = 0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("movePhoneState", () => {
	it("moves the phone database, its keys and the listener files, then removes the old root", () => {
		const key = seedPhone(oldRoot);

		const result = movePhoneState(oldRoot, newRoot, log);

		expect(result).toEqual({ moved: true, failures: [] });
		expect(existsSync(oldRoot)).toBe(false);
		expect(readFileSync(join(newRoot, "listener.log"), "utf8")).toBe(
			"listening\n",
		);
		expect(keyAt(newRoot)).toEqual(key);
		expect(statSync(newRoot).mode & 0o777).toBe(0o700);
		expect(statSync(join(newRoot, "phone.db")).mode & 0o777).toBe(0o600);
	});

	it("keeps the old root and writes nothing else when the copy is corrupted", () => {
		seedPhone(oldRoot);
		const before = readFileSync(join(oldRoot, "phone.db"));

		const result = movePhoneState(oldRoot, newRoot, log, {
			afterCopy: (copy) => truncateSync(join(copy, "phone.db"), 100),
		});

		expect(result.moved).toBe(false);
		expect(result.failures.length).toBeGreaterThan(0);
		expect(readFileSync(join(oldRoot, "phone.db"))).toEqual(before);
		expect(existsSync(newRoot)).toBe(false);
		expect(lines).toContain("rollback: dg-agent phone __rollback-home");
	});

	it("fails verify when a file key in the copy does not decode", () => {
		seedPhone(oldRoot);

		const result = movePhoneState(oldRoot, newRoot, log, {
			afterCopy: (copy) => {
				const db = PhoneDb.openAt(join(copy, "phone.db"), copy);
				db.putKey({ id: "number", nsec: "nsec1broken", in_store: 0 });
				db.close();
			},
		});

		expect(result.moved).toBe(false);
		expect(result.failures.join(" ")).toContain("number");
		expect(existsSync(join(oldRoot, "phone.db"))).toBe(true);
	});

	it("does nothing when there is no old phone state", () => {
		expect(movePhoneState(oldRoot, newRoot, log)).toEqual({
			moved: false,
			failures: [],
		});
		expect(existsSync(newRoot)).toBe(false);
	});

	it("never overwrites phone state already at the new root", () => {
		seedPhone(oldRoot);
		const fresh = seedPhone(newRoot);

		const result = movePhoneState(oldRoot, newRoot, log);

		expect(result.moved).toBe(false);
		expect(keyAt(newRoot)).toEqual(fresh);
		expect(existsSync(join(oldRoot, "phone.db"))).toBe(true);
	});
});

describe("rollbackPhoneState", () => {
	it("copies the phone state back to the old root and keeps the new copy", () => {
		const key = seedPhone(newRoot);

		const result = rollbackPhoneState(newRoot, oldRoot, log);

		expect(result).toEqual({ moved: true, failures: [] });
		expect(keyAt(oldRoot)).toEqual(key);
		expect(readdirSync(newRoot)).toContain("phone.db");
	});

	it("refuses to overwrite an old root that still exists", () => {
		seedPhone(newRoot);
		mkdirSync(oldRoot, { recursive: true });

		const result = rollbackPhoneState(newRoot, oldRoot, log);

		expect(result.moved).toBe(false);
		expect(result.failures[0]).toContain(oldRoot);
	});
});

describe("phone __refresh after the layout change", () => {
	function refreshDeps(paths: DgPaths, calls: { killed: number[]; written: string[]; spawned: string[][] }): OpenCloseDeps {
		let db: PhoneDb | undefined;
		return {
			paths,
			get db() {
				db ??= PhoneDb.open(paths);
				return db;
			},
			sessionClient: async () => undefined,
			grantClient: () => {
				throw new Error("no grant in file-mode tests");
			},
			createPool: () => {
				throw new Error("refresh needs no relay pool");
			},
			write: () => {},
			writeErr: (text) => lines.push(text.trim()),
			readStdin: async () => undefined,
			now: () => 1_800_000_000,
			platform: "linux",
			homeDir: "/home/u",
			env: {},
			uid: 501,
			writeFile: (path, text) => calls.written.push(`${path}\n${String(text)}`),
			removeFile: () => {},
			fileExists: () => false,
			run: async () => ({ code: 0, stdout: "", stderr: "" }),
			which: (name) => `/usr/bin/${name}`,
			listenerArgv: (extra) => listenerArgvFor(paths, ["phone", "__run", ...extra].slice(2)),
			spawnListener: (argv) => {
				calls.spawned.push(argv);
				return 7000;
			},
			kill: (pid) => {
				calls.killed.push(pid);
				rmSync(listenerPidPath({ ...paths, phoneRoot: join(paths.legacyHome, "phone") }), { force: true });
			},
			isOurListener: () => true,
			sleep: async () => {},
		};
	}

	it("stops the old listener, moves the phone state, and installs the unit from the new layout", async () => {
		const root = join(dir, "dg-home");
		const paths = resolveDgPaths({ platform: "linux", homeDir: "/home/u", env: { DG_HOME: root } });
		const key = seedPhone(join(root, "phone"));
		writeFileSync(join(root, "phone", "listener.pid"), JSON.stringify({ pid: process.ppid, since: 1, hook: null, version: "1.0.0" }));
		const calls = { killed: [] as number[], written: [] as string[], spawned: [] as string[][] };

		await phoneRefresh(refreshDeps(paths, calls));

		expect(calls.killed).toEqual([process.ppid]);
		expect(existsSync(join(root, "phone"))).toBe(false);
		expect(keyAt(paths.phoneRoot)).toEqual(key);
		const unit = calls.written.find((entry) => entry.includes("[Service]")) ?? "";
		expect(unit).toContain(join(root, "data", "runtime", "current", "bun"));
	});
});

describe("listener unit text", () => {
	const paths = resolveDgPaths({ platform: "linux", homeDir: "/home/u", env: {} });
	const spec = { argv: listenerArgvFor(paths, []), logPath: join(paths.phoneRoot, "listener.log") };

	it("names the absolute launcher path and never ~ or $HOME", () => {
		for (const text of [systemdUnitText(spec), launchdPlistText(spec), windowsTaskXml(spec)]) {
			expect(text).toContain("/home/u/.local/share/dg/runtime/current/bun");
			expect(text).not.toContain("~");
			expect(text).not.toContain("$HOME");
		}
	});
});
