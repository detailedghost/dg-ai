import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip17, nip19 } from "nostr-tools";
import { phoneSay } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import {
	disableLegacyDaemonJobs,
	legacyRoot,
	legacyRootPresent,
	type JobCli,
	type MigrateDeps,
	migrateIfNeeded,
	migrationLockPath,
	resolveDaemonExecutable,
	runArgv,
	runDaemonJobCli,
	siblingDaemonPath,
} from "../../src/phone/migrate";
import { DEFAULT_RELAYS, findContactByHandle, numberKeyId, readCursor, readNumber } from "../../src/phone/store";
import { createFakePool, freshNpub, makePhoneDeps, makeTempHome } from "./fake-pool";

const NOW = 1_800_000_000;

function freshHome(): string {
	return makeTempHome("dg-phone-migrate-");
}

type LegacyMessageFixture = {
	id: string;
	direction: "in" | "out";
	ts: number;
	sender: string;
	contact: string;
	text: string;
	call?: boolean;
	readAt?: number | null;
};

type LegacyLineFixture = {
	contact?: string;
	name?: string;
	relays?: string[];
	nsec?: string;
	keyInStore?: boolean;
	invite?: { secret: string; expiresAt: number; name?: string; as?: string };
	cursor?: number;
	messages?: LegacyMessageFixture[];
	listenerPid?: number;
};

/** Builds a line database in the exact v1 shape phone-friend wrote it in, from the schema kept
 * here (see `git show 70fc701:pkg/dg-agent/src/phone-friend/db.ts`), so the migration under test
 * reads real legacy bytes rather than a stand-in fixture format. */
function writeLegacyLine(paths: DgPaths, line: string, fixture: LegacyLineFixture): void {
	const dir = join(paths.phoneFriendRoot, line);
	mkdirSync(dir, { recursive: true });
	const db = new Database(join(dir, "phone-friend.db"), { create: true, strict: true });
	db.run(`CREATE TABLE messages (
		id TEXT PRIMARY KEY,
		direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
		ts INTEGER NOT NULL,
		sender TEXT NOT NULL,
		contact TEXT NOT NULL,
		text TEXT NOT NULL,
		call INTEGER NOT NULL DEFAULT 0,
		read_at INTEGER
	) STRICT`);
	db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
	const setSetting = (key: string, value: unknown) =>
		db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({ key, value: JSON.stringify(value) });
	if (fixture.contact !== undefined || fixture.name !== undefined || fixture.relays !== undefined) {
		setSetting("config", {
			relays: fixture.relays ?? DEFAULT_RELAYS,
			contact: fixture.contact,
			name: fixture.name,
		});
	}
	if (fixture.nsec !== undefined) setSetting("nsec", fixture.nsec);
	if (fixture.keyInStore) setSetting("key_in_store", true);
	if (fixture.invite !== undefined) setSetting("invite", fixture.invite);
	if (fixture.cursor !== undefined) setSetting("cursor", fixture.cursor);
	const insertMessage = db.query(
		`INSERT INTO messages (id, direction, ts, sender, contact, text, call, read_at)
		VALUES ($id, $direction, $ts, $sender, $contact, $text, $call, $readAt)`,
	);
	for (const message of fixture.messages ?? []) {
		insertMessage.run({
			id: message.id,
			direction: message.direction,
			ts: message.ts,
			sender: message.sender,
			contact: message.contact,
			text: message.text,
			call: message.call ? 1 : 0,
			readAt: message.readAt ?? null,
		});
	}
	db.close();
	if (fixture.listenerPid !== undefined) {
		writeFileSync(join(dir, "listener.pid"), `${fixture.listenerPid}\n`);
	}
}

function writeWhoami(paths: DgPaths, name: string): void {
	mkdirSync(paths.phoneFriendRoot, { recursive: true });
	writeFileSync(join(paths.phoneFriendRoot, ".whoami"), `${name}\n`);
}

function fakeMigrateDeps(overrides: Partial<MigrateDeps> = {}): MigrateDeps {
	return {
		now: () => NOW,
		isOurListener: () => false,
		isAlive: () => false,
		kill: () => {},
		jobCli: async () => ({ code: 0, stdout: "", stderr: "" }),
		renameLegacyRoot: renameSync,
		writeErr: () => {},
		...overrides,
	};
}

describe("legacyRoot / migrateIfNeeded", () => {
	it("is undefined on a fresh install with neither root", () => {
		const home = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			expect(legacyRoot(paths)).toBeUndefined();
			expect(migrateIfNeeded(paths)).toEqual({ migrated: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("finds the old root once a line database exists there, and stops once phone.db exists", () => {
		const home = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			mkdirSync(join(paths.phoneFriendRoot, "default"), { recursive: true });
			writeFileSync(join(paths.phoneFriendRoot, "default", "phone-friend.db"), "");

			expect(legacyRoot(paths)).toBe(paths.phoneFriendRoot);

			const db = PhoneDb.open(paths);
			db.close();
			expect(legacyRoot(paths)).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("ignores a phone-friend root with no line database in it", () => {
		const home = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			mkdirSync(paths.phoneFriendRoot, { recursive: true });

			expect(legacyRoot(paths)).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("legacyRootPresent", () => {
	it("is false for an empty old root that was never a real line install, even once phone.db exists", () => {
		const home = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			mkdirSync(paths.phoneFriendRoot, { recursive: true });

			const db = PhoneDb.open(paths);
			db.close();

			expect(legacyRootPresent(paths)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("is true once phone.db exists next to an unrenamed root that still holds a line database", () => {
		const home = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			mkdirSync(join(paths.phoneFriendRoot, "default"), { recursive: true });
			writeFileSync(join(paths.phoneFriendRoot, "default", "phone-friend.db"), "");

			const db = PhoneDb.open(paths);
			db.close();

			expect(legacyRootPresent(paths)).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("resolveDaemonExecutable", () => {
	it("prefers the daemon beside this executable", () => {
		expect(siblingDaemonPath("/opt/dg/dg-agent", "linux")).toBe("/opt/dg/dg-daemon");
		expect(siblingDaemonPath("/opt/dg/dg-agent.exe", "win32")).toBe("/opt/dg/dg-daemon.exe");
		expect(
			resolveDaemonExecutable("/opt/dg/dg-agent", "linux", (path) => path.endsWith("dg-daemon"), () => "/usr/bin/dg-daemon"),
		).toBe("/opt/dg/dg-daemon");
	});

	it("uses PATH when the sibling is absent", () => {
		expect(
			resolveDaemonExecutable("/opt/dg/dg-agent", "linux", () => false, (name) =>
				name === "dg-daemon" ? "/usr/bin/dg-daemon" : undefined,
			),
		).toBe("/usr/bin/dg-daemon");
	});

	it("says how to install dg-daemon when neither place has it", () => {
		expect(() => resolveDaemonExecutable("/opt/dg/dg-agent", "linux", () => false, () => undefined)).toThrow(
			"dg-skills install",
		);
	});
});

describe("runArgv", () => {
	it("captures stdout and the env it was given", async () => {
		const ran = await runArgv([process.execPath, "-e", "console.log(process.env.MARKER ?? '')"], {
			...process.env,
			MARKER: "dg-phone-migrate",
		});

		expect(ran.code).toBe(0);
		expect(ran.stdout).toBe("dg-phone-migrate\n");
	});

	it("captures a non-zero exit and stderr", async () => {
		const ran = await runArgv([process.execPath, "-e", "console.error('nope'); process.exit(3)"], process.env);

		expect(ran.code).toBe(3);
		expect(ran.stderr).toContain("nope");
	});

	it("returns a failure when the executable cannot be spawned", async () => {
		const ran = await runArgv(["/no/such/dg-daemon-binary"], process.env);

		expect(ran.code).not.toBe(0);
		expect(ran.stdout).toBe("");
		expect(ran.stderr.length).toBeGreaterThan(0);
	});
});

describe("runDaemonJobCli", () => {
	it("runs the dg-daemon found on PATH and forwards the job arguments", async () => {
		const bin = mkdtempSync(join(tmpdir(), "dg-daemon-bin-"));
		writeFileSync(join(bin, "dg-daemon"), "#!/bin/sh\nprintf '%s\n' \"$@\"\n");
		chmodSync(join(bin, "dg-daemon"), 0o755);
		const previous = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
		try {
			const ran = await runDaemonJobCli(["job", "list"]);
			expect(ran.code).toBe(0);
			expect(ran.stdout).toBe("job\nlist\n");
		} finally {
			process.env.PATH = previous;
			rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("migrateIfNeeded: moving legacy data into phone.db", () => {
	it("moves two lines' keys, contacts, and messages, keeping one unread mark and picking the default key", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			const defaultContact = freshNpub();
			const workContact = freshNpub();
			writeLegacyLine(paths, "default", {
				contact: defaultContact,
				nsec: nip19.nsecEncode(generateSecretKey()),
				cursor: 500,
				messages: [
					{ id: "d1", direction: "in", ts: NOW - 500, sender: defaultContact, contact: defaultContact, text: "hi1", readAt: NOW - 490 },
					{ id: "d2", direction: "in", ts: NOW - 400, sender: defaultContact, contact: defaultContact, text: "hi2", readAt: NOW - 390 },
					{ id: "d3", direction: "in", ts: NOW - 300, sender: defaultContact, contact: defaultContact, text: "hi3", readAt: null },
					{ id: "d4", direction: "out", ts: NOW - 250, sender: "npub1us", contact: defaultContact, text: "reply", readAt: NOW - 240 },
				],
			});
			writeLegacyLine(paths, "work", {
				contact: workContact,
				name: "velora",
				nsec: nip19.nsecEncode(generateSecretKey()),
				cursor: 50,
				messages: [
					{ id: "w1", direction: "in", ts: NOW - 480, sender: workContact, contact: workContact, text: "yo1", readAt: NOW - 470 },
					{ id: "w2", direction: "in", ts: NOW - 460, sender: workContact, contact: workContact, text: "yo2", readAt: NOW - 450 },
				],
			});

			const result = migrateIfNeeded(paths, fakeMigrateDeps());
			if (result.migrated !== true) throw new Error("expected a migration");
			expect(result.lines).toBe(2);
			expect(result.contacts).toBe(2);
			expect(result.messages).toBe(6);
			expect(result.numberKey).toBe("default");

			const db = PhoneDb.open(paths, () => NOW);
			try {
				expect(db.getKey("default")).toBeDefined();
				expect(db.getKey("work")).toBeDefined();
				expect(findContactByHandle(db, "default")?.npub).toBe(defaultContact);
				expect(findContactByHandle(db, "velora")?.npub).toBe(workContact);
				expect(db.recentMessages(100)).toHaveLength(6);
				expect(db.unreadMessages()).toHaveLength(1);
				expect(numberKeyId(db)).toBe("default");
				expect(readCursor(db)).toBe(50);
			} finally {
				db.close();
			}

			expect(existsSync(paths.phoneFriendRoot)).toBe(false);
			expect(existsSync(`${paths.phoneFriendRoot}.migrated`)).toBe(true);
			expect(existsSync(migrationLockPath(paths))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("picks the first line by name when there is no default line", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "zara", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });
			writeLegacyLine(paths, "alice", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });

			const result = migrateIfNeeded(paths, fakeMigrateDeps());
			if (result.migrated !== true) throw new Error("expected a migration");
			expect(result.numberKey).toBe("alice");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("de-dupes two lines whose config.name collide into +shared and +shared-2", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			const firstContact = freshNpub();
			const secondContact = freshNpub();
			writeLegacyLine(paths, "line-a", { contact: firstContact, name: "shared", nsec: nip19.nsecEncode(generateSecretKey()) });
			writeLegacyLine(paths, "line-b", { contact: secondContact, name: "shared", nsec: nip19.nsecEncode(generateSecretKey()) });

			migrateIfNeeded(paths, fakeMigrateDeps());

			const db = PhoneDb.open(paths, () => NOW);
			try {
				expect(findContactByHandle(db, "shared")?.npub).toBe(firstContact);
				expect(findContactByHandle(db, "shared-2")?.npub).toBe(secondContact);
			} finally {
				db.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a line's key with no contact when the line never had one", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "lonely", { nsec: nip19.nsecEncode(generateSecretKey()) });

			const result = migrateIfNeeded(paths, fakeMigrateDeps());
			if (result.migrated !== true) throw new Error("expected a migration");
			expect(result.contacts).toBe(0);

			const db = PhoneDb.open(paths, () => NOW);
			try {
				expect(db.getKey("lonely")).toBeDefined();
			} finally {
				db.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("carries .whoami into the number's self name", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });
			writeWhoami(paths, "dante");

			migrateIfNeeded(paths, fakeMigrateDeps());

			const db = PhoneDb.open(paths, () => NOW);
			try {
				expect(readNumber(db)?.as).toBe("dante");
			} finally {
				db.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to dg when .whoami was never set", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });

			migrateIfNeeded(paths, fakeMigrateDeps());

			const db = PhoneDb.open(paths, () => NOW);
			try {
				expect(readNumber(db)?.as).toBe("dg");
			} finally {
				db.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a store-mode key's flag with no nsec and makes no credential-store call", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", { contact: freshNpub(), keyInStore: true });

			migrateIfNeeded(paths, fakeMigrateDeps());

			const db = PhoneDb.open(paths, () => NOW);
			try {
				const key = db.getKey("default");
				expect(key?.in_store).toBe(1);
				expect(key?.nsec).toBeNull();
			} finally {
				db.close();
			}
			expect(existsSync(paths.daemonDir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("aborts before phone.db exists when a line database cannot be read, and leaves the old root untouched", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });
			mkdirSync(join(paths.phoneFriendRoot, "broken"), { recursive: true });
			writeFileSync(join(paths.phoneFriendRoot, "broken", "phone-friend.db"), "not a sqlite file");

			expect(() => migrateIfNeeded(paths, fakeMigrateDeps())).toThrow("file is not a database");

			expect(existsSync(PhoneDb.path(paths))).toBe(false);
			expect(existsSync(paths.phoneFriendRoot)).toBe(true);
			expect(existsSync(join(paths.phoneFriendRoot, "default", "phone-friend.db"))).toBe(true);
			expect(existsSync(migrationLockPath(paths))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves the old root in place when the rollback rename fails, and does not migrate again", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });

			const result = migrateIfNeeded(
				paths,
				fakeMigrateDeps({
					renameLegacyRoot: () => {
						throw new Error("rename refused");
					},
				}),
			);

			expect(result.migrated).toBe(true);
			expect(existsSync(PhoneDb.path(paths))).toBe(true);
			expect(existsSync(paths.phoneFriendRoot)).toBe(true);
			expect(legacyRootPresent(paths)).toBe(true);

			expect(migrateIfNeeded(paths, fakeMigrateDeps())).toEqual({ migrated: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a migrated contact's own signing key, so an old peer's one-npub gate keeps accepting us", async () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			const workSecret = generateSecretKey();
			const contactSk = generateSecretKey();
			const contactNpub = nip19.npubEncode(getPublicKey(contactSk));
			writeLegacyLine(paths, "work", { contact: contactNpub, name: "velora", nsec: nip19.nsecEncode(workSecret) });

			migrateIfNeeded(paths, fakeMigrateDeps());

			const pool = createFakePool();
			const out: string[] = [];
			const deps = makePhoneDeps({ home: dir, pool, write: (text) => out.push(text), now: NOW });
			try {
				await phoneSay("+velora", "hi", deps);
			} finally {
				deps.db.close();
			}

			const [sentEvent] = pool.events;
			const rumor = nip17.unwrapEvent(sentEvent, contactSk);
			expect(rumor.pubkey).toBe(getPublicKey(workSecret));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("migrateIfNeeded: the migration lock", () => {
	it("throws when another live process already holds the migration lock, and writes nothing", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });
			mkdirSync(paths.phoneRoot, { recursive: true });
			writeFileSync(migrationLockPath(paths), "4242");

			expect(() => migrateIfNeeded(paths, fakeMigrateDeps({ isAlive: (pid) => pid === 4242 }))).toThrow(
				"another phone command is migrating (pid 4242)",
			);
			expect(existsSync(PhoneDb.path(paths))).toBe(false);
			expect(existsSync(migrationLockPath(paths))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reclaims a lock left by a dead process and migrates normally", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });
			mkdirSync(paths.phoneRoot, { recursive: true });
			writeFileSync(migrationLockPath(paths), "4242");

			const result = migrateIfNeeded(paths, fakeMigrateDeps({ isAlive: () => false }));

			expect(result.migrated).toBe(true);
			expect(existsSync(migrationLockPath(paths))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("releases the lock even when the migration throws", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			mkdirSync(join(paths.phoneFriendRoot, "default"), { recursive: true });
			writeFileSync(join(paths.phoneFriendRoot, "default", "phone-friend.db"), "not a sqlite file");

			expect(() => migrateIfNeeded(paths, fakeMigrateDeps())).toThrow();
			expect(existsSync(migrationLockPath(paths))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("migrateIfNeeded: stopping a live old listener", () => {
	it("kills a pid isOurListener recognizes and removes its pid file", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", {
				contact: freshNpub(),
				nsec: nip19.nsecEncode(generateSecretKey()),
				listenerPid: 4242,
			});
			const killed: number[] = [];

			migrateIfNeeded(
				paths,
				fakeMigrateDeps({
					isOurListener: (pid) => pid === 4242,
					kill: (pid) => {
						killed.push(pid);
					},
					renameLegacyRoot: () => {},
				}),
			);

			expect(killed).toEqual([4242]);
			expect(existsSync(join(paths.phoneFriendRoot, "default", "listener.pid"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves a pid alone when isOurListener says it is not ours", () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", {
				contact: freshNpub(),
				nsec: nip19.nsecEncode(generateSecretKey()),
				listenerPid: 4242,
			});
			const killed: number[] = [];

			migrateIfNeeded(
				paths,
				fakeMigrateDeps({
					isOurListener: () => false,
					kill: (pid) => {
						killed.push(pid);
					},
					renameLegacyRoot: () => {},
				}),
			);

			expect(killed).toEqual([]);
			expect(existsSync(join(paths.phoneFriendRoot, "default", "listener.pid"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("disableLegacyDaemonJobs", () => {
	it("tries every line's job label and reports only the ones it actually disabled", async () => {
		const calls: string[][] = [];
		const jobCli: JobCli = async (args) => {
			calls.push(args);
			if (args[2] === "phone-friend:broken") return { code: 1, stdout: "", stderr: "no job labelled" };
			return { code: 0, stdout: "", stderr: "" };
		};

		const disabled = await disableLegacyDaemonJobs(["default", "broken", "work"], jobCli);

		expect(calls).toEqual([
			["job", "disable", "phone-friend:default"],
			["job", "disable", "phone-friend:broken"],
			["job", "disable", "phone-friend:work"],
		]);
		expect(disabled).toEqual(["phone-friend:default", "phone-friend:work"]);
	});

	it("ignores a thrown error from the job cli", async () => {
		const jobCli: JobCli = async () => {
			throw new Error("dg-daemon not found");
		};

		await expect(disableLegacyDaemonJobs(["default"], jobCli)).resolves.toEqual([]);
	});
});

describe("migrateIfNeeded: the one-time stderr summary", () => {
	it("prints once, after the job-disable attempts settle, naming the disabled jobs", async () => {
		const dir = freshHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dir } });
			writeLegacyLine(paths, "default", { contact: freshNpub(), nsec: nip19.nsecEncode(generateSecretKey()) });
			const printed: string[] = [];

			const result = migrateIfNeeded(
				paths,
				fakeMigrateDeps({
					jobCli: async () => ({ code: 0, stdout: "", stderr: "" }),
					writeErr: (text) => {
						printed.push(text);
					},
				}),
			);
			if (result.migrated !== true) throw new Error("expected a migration");
			const disabled = await result.jobsDisabled;

			expect(disabled).toEqual(["phone-friend:default"]);
			expect(printed).toHaveLength(1);
			expect(JSON.parse(printed[0])).toEqual({
				migrated: true,
				lines: 1,
				contacts: 1,
				messages: 0,
				number_key: "default",
				jobs_disabled: ["phone-friend:default"],
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
