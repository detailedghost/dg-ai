import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { assertNotBlocked, ensureLayout, layoutResult, type LayoutHooks } from "@dg/common/node/layout";
import { Command } from "commander";
import { phoneLayoutHooks } from "../src/layout-hooks";
import { hooksFor } from "../src/main";
import { PhoneDb } from "../src/phone/db";
import { createFileKey } from "../src/phone/keys";
import { type PhoneApi, registerPhoneGroup } from "../src/phone/register";

const FAKE_VERSION = "1.0.0";

let dir: string;
let paths: DgPaths;
let lines: string[];

const log = (line: string): void => {
	lines.push(line);
};

const legacyPhone = (): string => join(paths.legacyHome, "phone");
const legacyPidFile = (): string => join(legacyPhone(), "listener.pid");

function seedPhone(root: string, contacts: boolean): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const db = PhoneDb.openAt(join(root, "phone.db"), root);
	if (contacts) {
		createFileKey(db, "number");
		db.insertContact({ npub: "npub1x", handle: "+dg", relays: "[]", key_id: "number", added_at: 1, via: "card" });
	}
	db.close();
}

function seedLiveListener(root: string): void {
	writeFileSync(join(root, "listener.pid"), JSON.stringify({ pid: process.ppid, since: 1, hook: null, version: FAKE_VERSION }));
}

function seedMemory(): void {
	mkdirSync(join(paths.legacyHome, "agents"), { recursive: true });
	const db = new Database(join(paths.legacyHome, "agents", "memory.db"));
	db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
	db.run("INSERT INTO notes (body) VALUES ('kept')");
	db.close();
}

function fakeListenerDeps(calls: { killed: number[]; asked: number[] }) {
	return {
		isOurListener: (pid: number) => {
			calls.asked.push(pid);
			return true;
		},
		kill: (pid: number) => {
			calls.killed.push(pid);
			rmSync(legacyPidFile(), { force: true });
		},
		sleep: async () => {},
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dg-agent-layout-"));
	paths = resolveDgPaths({ platform: "linux", homeDir: join(dir, "home"), env: {} });
	lines = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("phoneLayoutHooks phone.verify", () => {
	const { "phone.verify": verify } = phoneLayoutHooks({ isOurListener: () => false, kill: () => {}, sleep: async () => {} });

	it("returns one problem naming phone.db for a corrupt database", () => {
		const root = join(dir, "copy");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "phone.db"), "this is not a sqlite database");

		const problems = verify(root);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(join(root, "phone.db"));
	});

	it("returns one problem naming the key id when a file key does not decode", () => {
		const root = join(dir, "copy");
		seedPhone(root, false);
		const db = PhoneDb.openAt(join(root, "phone.db"), root);
		db.putKey({ id: "broken-key", nsec: "nsec1broken", in_store: 0 });
		db.close();

		const problems = verify(root);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("broken-key");
	});

	it("returns no problem for a good root", () => {
		const root = join(dir, "copy");
		seedPhone(root, true);

		expect(verify(root)).toEqual([]);
	});
});

describe("phoneLayoutHooks phone.stop", () => {
	it("sends SIGTERM to a listener isOurListener accepts and returns stopped once the pid file is gone", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		const calls = { killed: [] as number[], asked: [] as number[] };
		const hooks = phoneLayoutHooks(fakeListenerDeps(calls));

		const result = await hooks["phone.stop"](legacyPhone());

		expect(result).toBe("stopped");
		expect(calls.asked).toEqual([process.ppid, process.ppid]);
		expect(calls.killed).toEqual([process.ppid]);
	});

	it("returns stopped without a signal for a pid isOurListener rejects", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		const killed: number[] = [];
		const hooks = phoneLayoutHooks({ isOurListener: () => false, kill: (pid) => killed.push(pid), sleep: async () => {} });

		const result = await hooks["phone.stop"](legacyPhone());

		expect(result).toBe("stopped");
		expect(killed).toEqual([]);
	});

	it("returns still-running when the listener does not exit after the signal", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		const hooks = phoneLayoutHooks({ isOurListener: () => true, kill: () => {}, sleep: async () => {} });

		expect(await hooks["phone.stop"](legacyPhone())).toBe("still-running");
	});
});

describe("phone group preAction after ensureLayout", () => {
	function fakeApi(calls: string[], stdout: string[] = []): PhoneApi {
		return {
			deps: () => ({ paths }),
			openCloseDeps: () => ({ paths, write: (text: string) => stdout.push(text) }),
			phoneOpen: async (_opts: unknown, deps: { write(text: string): void }) => {
				deps.write("listener started");
				calls.push("open");
			},
			phoneClose: async () => {
				calls.push("close");
			},
			phoneRefresh: async () => {
				calls.push("refresh");
			},
			phoneStatus: async () => {
				calls.push("status");
			},
			phoneContacts: () => {
				calls.push("contacts");
			},
			phoneRun: async () => {
				calls.push("run");
			},
			ignoreHangup: () => {},
			runDeps: () => ({ paths }),
		} as unknown as PhoneApi;
	}

	async function drive(calls: string[], ...argv: string[]): Promise<void> {
		await driveWithStdout(calls, [], ...argv);
	}

	async function driveWithStdout(calls: string[], stdout: string[], ...argv: string[]): Promise<void> {
		const program = new Command().exitOverride();
		registerPhoneGroup(program, async () => fakeApi(calls, stdout));
		await program.parseAsync(["phone", ...argv], { from: "user" });
	}

	async function layoutForPhoneVerb(): Promise<{ killed: number[]; asked: number[] }> {
		const calls = { killed: [] as number[], asked: [] as number[] };
		await ensureLayout(paths, { log, ...phoneLayoutHooks(fakeListenerDeps(calls)) });
		return calls;
	}

	it("stops a live legacy listener, moves phone, and restarts the listener once for phone status", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		const signals = await layoutForPhoneVerb();
		const calls: string[] = [];

		await drive(calls, "status");

		expect(signals.killed).toEqual([process.ppid]);
		expect(layoutResult(paths)?.phone).toMatchObject({ kind: "moved", stopped: true });
		expect(existsSync(join(paths.phoneRoot, "phone.db"))).toBe(true);
		expect(existsSync(legacyPhone())).toBe(false);
		expect(calls.filter((call) => call === "open")).toHaveLength(1);
		expect(calls).toContain("status");
	});

	it("keeps the restart output off stdout", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		await layoutForPhoneVerb();
		const calls: string[] = [];
		const stdout: string[] = [];

		await driveWithStdout(calls, stdout, "contacts");

		expect(calls).toContain("open");
		expect(stdout).toEqual([]);
	});

	it("restarts for open, since a cron-only open does not start the listener", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		await layoutForPhoneVerb();
		const calls: string[] = [];

		await drive(calls, "open", "--print-cron");

		expect(calls.slice(0, 2)).toEqual(["open", "open"]);
	});

	it("reports setAside with stopped true and restarts once when the per-OS phone root is unused", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		seedPhone(paths.phoneRoot, false);
		await layoutForPhoneVerb();
		const calls: string[] = [];

		await drive(calls, "contacts");

		expect(layoutResult(paths)?.phone).toMatchObject({ kind: "setAside", stopped: true });
		expect(calls.filter((call) => call === "open")).toHaveLength(1);
	});

	it("reports stopped and restarts once when the legacy pid is live but isOurListener rejects it", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		const signals = { killed: [] as number[], asked: [] as number[] };
		const deps = { ...fakeListenerDeps(signals), isOurListener: (pid: number) => (signals.asked.push(pid), false) };
		await ensureLayout(paths, { log, ...phoneLayoutHooks(deps) });
		const calls: string[] = [];

		await drive(calls, "status");

		expect(signals.asked).toEqual([process.ppid]);
		expect(signals.killed).toEqual([]);
		expect(layoutResult(paths)?.phone).toMatchObject({ kind: "moved", stopped: true });
		expect(calls.filter((call) => call === "open")).toHaveLength(1);
	});

	it("does not restart the listener for close after a stopped-and-moved phone", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		await layoutForPhoneVerb();
		const calls: string[] = [];

		await drive(calls, "close");

		expect(calls).toEqual(["close"]);
	});

	it("starts the listener once for refresh after a stopped-and-moved phone", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		await layoutForPhoneVerb();
		const calls: string[] = [];

		await drive(calls, "refresh");

		expect(calls.filter((call) => call === "open")).toHaveLength(1);
		expect(calls).toContain("refresh");
	});

	it("does nothing for the listener process before ensureLayout ran, and never restarts", async () => {
		const calls: string[] = [];

		await drive(calls, "listen");

		expect(calls).toEqual(["run"]);
	});

	it("does not restart when the layout result is absent because the command skipped ensureLayout", async () => {
		const calls: string[] = [];

		await drive(calls, "contacts");

		expect(layoutResult(paths)).toBeUndefined();
		expect(calls).toEqual(["contacts"]);
	});

	it("does not restart when phone moved without a stopped listener", async () => {
		seedPhone(legacyPhone(), true);
		await layoutForPhoneVerb();
		const calls: string[] = [];

		await drive(calls, "contacts");

		expect(layoutResult(paths)?.phone).toMatchObject({ kind: "moved", stopped: false });
		expect(calls).toEqual(["contacts"]);
	});
});

describe("a non-phone dg-agent command with a live legacy listener", () => {
	it("blocks phone with one stderr line, moves memory, and leaves the listener running", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		seedMemory();
		const { "phone.verify": verify } = phoneLayoutHooks({ isOurListener: () => true, kill: () => {}, sleep: async () => {} });
		const hooks: LayoutHooks = { log, "phone.verify": verify };

		const result = await ensureLayout(paths, hooks);

		expect(result.phone).toMatchObject({ kind: "blocked", reason: "live-writer" });
		expect(result.memory).toMatchObject({ kind: "moved" });
		expect(existsSync(paths.memoryDbPath)).toBe(true);
		expect(lines.filter((line) => line.includes(legacyPhone()))).toHaveLength(1);
		expect(readFileSync(legacyPidFile(), "utf8")).toContain(String(process.ppid));
	});

	it("moves phone from any command when no listener is live", async () => {
		seedPhone(legacyPhone(), true);
		const { "phone.verify": verify } = phoneLayoutHooks({ isOurListener: () => true, kill: () => {}, sleep: async () => {} });

		const result = await ensureLayout(paths, { log, "phone.verify": verify });

		expect(result.phone).toMatchObject({ kind: "moved", stopped: false });
		expect(existsSync(join(paths.phoneRoot, "phone.db"))).toBe(true);
	});
});

describe("PhoneDb.open on a blocked or unmoved phone", () => {
	it("throws the kept text and creates no phone.db when the layout result blocked phone", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		const { "phone.verify": verify } = phoneLayoutHooks({ isOurListener: () => true, kill: () => {}, sleep: async () => {} });
		await ensureLayout(paths, { log, "phone.verify": verify });
		let thrown: unknown;

		try {
			PhoneDb.open(paths);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain(`kept ${legacyPhone()}`);
		expect(existsSync(join(paths.phoneRoot, "phone.db"))).toBe(false);
		expect(() => assertNotBlocked(paths, "phone")).toThrow();
	});

	it("throws the has-not-moved text and creates no phone.db for an unmoved legacy phone with no cached result", () => {
		seedPhone(legacyPhone(), true);

		expect(() => PhoneDb.open(paths)).toThrow(`dg: ${legacyPhone()} has not moved to ${paths.phoneRoot}; run dg-skills install`);
		expect(existsSync(join(paths.phoneRoot, "phone.db"))).toBe(false);
	});
});

describe("main hooksFor", () => {
	function leaf(...path: string[]): Command {
		const program = new Command().name("dg-agent");
		return path.reduce((parent, name) => parent.command(name), program);
	}

	async function loadedKeys(action: Command): Promise<string[]> {
		const hooks = hooksFor(action);
		await hooks.load?.();
		return Object.keys(hooks).filter((key) => key !== "load").sort();
	}

	it.each([
		["phone status", ["phone", "status"]],
		["phone vault add", ["phone", "vault", "add"]],
		["phone vault list", ["phone", "vault", "list"]],
		["phone contacts rename", ["phone", "contacts", "rename"]],
		["phone group new", ["phone", "group", "new"]],
		["phone thread show", ["phone", "thread", "show"]],
	])("supplies phone.verify and phone.stop for %s", async (_label, path) => {
		expect(await loadedKeys(leaf(...path))).toEqual(["phone.stop", "phone.verify"]);
	});

	it("supplies only phone.verify for a command outside phone, even when its parent group has another name", async () => {
		expect(await loadedKeys(leaf("memory", "search"))).toEqual(["phone.verify"]);
		expect(await loadedKeys(leaf("vault", "list"))).toEqual(["phone.verify"]);
	});

	it("stops a live legacy listener for a nested phone verb and moves phone", async () => {
		seedPhone(legacyPhone(), true);
		seedLiveListener(legacyPhone());
		const calls = { killed: [] as number[], asked: [] as number[] };
		const action = leaf("phone", "vault", "list");
		const hooks = hooksFor(action);
		await hooks.load?.();
		const fake = phoneLayoutHooks(fakeListenerDeps(calls));

		const result = await ensureLayout(paths, {
			log,
			"phone.verify": fake["phone.verify"],
			...("phone.stop" in hooks ? { "phone.stop": fake["phone.stop"] } : {}),
		});

		expect(result.phone).toMatchObject({ kind: "moved", stopped: true });
		expect(calls.killed).toEqual([process.ppid]);
	});
});
