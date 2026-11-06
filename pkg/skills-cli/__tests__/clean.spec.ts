import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { type DgPaths, resolveDgPaths, withInstallLock } from "@dg/common/node";
import { blockedText, ensureLayout, type LayoutResult, moveEntries, withCliLockError } from "@dg/common/node/layout";
import { compatLauncherText, syncCompatLaunchers } from "../src/install/compat-launchers";
import { type CleanSnapshot, pendingCleanPaths, planClean, runClean } from "../src/install/clean";
import { cleanChecks } from "../src/install/clean-doctor";
import type { DoctorContext } from "../src/doctor/types";
import { PROGRAMS } from "../src/install/shims";

const posix = describe.skipIf(process.platform === "win32");

const STAMPS = { daemon: 1700000000000, phone: 1700000000001, "channel-review": 1700000000002 } as const;
type AsideName = keyof typeof STAMPS;

let dir: string;
let home: string;
let paths: DgPaths;

const hooksStub = { "ssms.configDir": () => "" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-clean-"));
	home = join(dir, "home");
	paths = resolveDgPaths({ platform: "linux", homeDir: home, env: {} });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (name: string) => {
	const found = moveEntries.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no layout entry ${name}`);
	return found;
};

const liveOf = (name: AsideName, target: DgPaths = paths): string => entry(name).to(target, hooksStub);

const asideOf = (name: AsideName, target: DgPaths = paths): string => `${liveOf(name, target)}.empty-${STAMPS[name]}`;

const putFile = (path: string, text = "x"): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

function putPhoneDb(root: string, rows: number): void {
	mkdirSync(root, { recursive: true });
	const db = new Database(join(root, "phone.db"));
	db.run("CREATE TABLE keys (id TEXT)");
	for (let row = 0; row < rows; row++) db.run("INSERT INTO keys (id) VALUES (?)", [`key-${row}`]);
	db.close();
}

function putAsides(target: DgPaths = paths): void {
	mkdirSync(asideOf("daemon", target), { recursive: true });
	putPhoneDb(asideOf("phone", target), 0);
	mkdirSync(asideOf("channel-review", target), { recursive: true });
}

function putLiveFolders(): void {
	putFile(join(liveOf("daemon"), "daemon.db"), "daemon rows");
	putPhoneDb(liveOf("phone"), 1);
	putFile(join(liveOf("channel-review"), "state.json"), "{}");
}

function treeOf(root: string): Record<string, string> {
	const found: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const name of readdirSync(current)) {
			const path = join(current, name);
			if (lstatSync(path).isDirectory()) {
				found[`${relative(root, path)}/`] = "";
				walk(path);
			} else found[relative(root, path)] = readFileSync(path).toString("base64");
		}
	};
	walk(root);
	return found;
}

type Seams = NonNullable<Parameters<typeof runClean>[1]>;

async function run(target: DgPaths, seams: Seams = {}): Promise<{ code: number; lines: string[] }> {
	const lines: string[] = [];
	const written: string[] = [];
	const realWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		const code = await runClean(target, { log: (line: string) => void lines.push(line), ...seams });
		return { code, lines };
	} finally {
		process.stdout.write = realWrite;
		expect(written).toEqual([]);
	}
}

const launcherFile = (name: string, platform: NodeJS.Platform = "linux"): string =>
	platform === "win32" ? `${name}.cmd` : name;

function putLaunchers(bin: string, platform: NodeJS.Platform = "linux"): void {
	for (const name of PROGRAMS) {
		const file = launcherFile(name, platform);
		putFile(join(bin, file), compatLauncherText(name, join(paths.binDir, file), "1.45.0", platform));
	}
}

const joined = (items: readonly string[]): string => `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const noticeLine = (platform: NodeJS.Platform = "linux"): string =>
	`dg: ${joined(PROGRAMS.map((name) => `~/.dg/bin/${launcherFile(name, platform)}`))} stop working; the launchers are in ${paths.binDir}`;

const idleResult = (): Promise<LayoutResult> => ensureLayout({ ...paths }, { log: () => {} });

describe("runClean set-asides", () => {
	test("removes the three unused set-asides, logs each and the count, and leaves the live folders byte-identical", async () => {
		putLiveFolders();
		putAsides();
		const before = Object.fromEntries((["daemon", "phone", "channel-review"] as const).map((name) => [name, treeOf(liveOf(name))]));

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual([
			`dg: removed ${asideOf("daemon")}`,
			`dg: removed ${asideOf("phone")}`,
			`dg: removed ${asideOf("channel-review")}`,
			"dg: removed 3 path(s)",
		]);
		for (const name of ["daemon", "phone", "channel-review"] as const) {
			expect(existsSync(asideOf(name))).toBe(false);
			expect(treeOf(liveOf(name))).toEqual(before[name]);
		}
	});

	test("writes every line to stderr and nothing to stdout when no log seam is given", async () => {
		putAsides();
		const errors: string[] = [];
		const outputs: string[] = [];
		const realErr = process.stderr.write;
		const realOut = process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
		process.stdout.write = ((chunk: string | Uint8Array) => (outputs.push(String(chunk)), true)) as typeof process.stdout.write;
		let code: number;
		try {
			code = await runClean(paths, {});
		} finally {
			process.stderr.write = realErr;
			process.stdout.write = realOut;
		}

		expect(code).toBe(0);
		expect(outputs).toEqual([]);
		expect(errors.join("")).toContain("dg: removed 3 path(s)\n");
		expect(errors.join("")).toContain(`dg: removed ${asideOf("phone")}\n`);
	});

	test("a second run after a full clean finds nothing to clean and returns 0", async () => {
	putLiveFolders();
	putAsides();
	await run(paths);

	const second = await run({ ...paths });

	expect(second.code).toBe(0);
	expect(second.lines).toEqual(["dg: nothing to clean"]);
});

test("keeps a phone set-aside whose phone.db holds a key row and removes the other two", async () => {
		putAsides();
		rmSync(asideOf("phone"), { recursive: true });
		putPhoneDb(asideOf("phone"), 1);

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toContain(`dg: kept ${asideOf("phone")}; it holds data`);
		expect(lines.at(-1)).toBe("dg: removed 2 path(s)");
		expect(existsSync(asideOf("phone"))).toBe(true);
		expect(existsSync(asideOf("daemon"))).toBe(false);
		expect(existsSync(asideOf("channel-review"))).toBe(false);
	});

	test("keeps a daemon set-aside that holds any file", async () => {
		putFile(join(asideOf("daemon"), "daemon.db"));

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual([`dg: kept ${asideOf("daemon")}; it holds data`, "dg: nothing to clean"]);
		expect(existsSync(asideOf("daemon"))).toBe(true);
	});

	test("keeps a phone set-aside with a non-empty phone.db-wal", async () => {
		putPhoneDb(asideOf("phone"), 0);
		writeFileSync(join(asideOf("phone"), "phone.db-wal"), "pending frames");

		const { lines } = await run(paths);

		expect(lines).toContain(`dg: kept ${asideOf("phone")}; it holds data`);
		expect(existsSync(asideOf("phone"))).toBe(true);
	});

	test("ignores a sibling whose name does not match the set-aside pattern", async () => {
		const stray = `${liveOf("daemon")}.empty-soon`;
		mkdirSync(stray, { recursive: true });

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual(["dg: nothing to clean"]);
		expect(existsSync(stray)).toBe(true);
	});

	test("returns 0 with the nothing-to-clean line when there is no set-aside and no legacy home", async () => {
		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual(["dg: nothing to clean"]);
	});

	test("logs the failed removal, removes the other set-asides and returns 1", async () => {
		putAsides();
		const removeTree = (path: string): void => {
			if (path === asideOf("phone")) throw new Error("boom");
			rmSync(path, { recursive: true, force: true });
		};

		const { code, lines } = await run(paths, { removeTree });

		expect(code).toBe(1);
		expect(lines).toContain(`dg: kept ${asideOf("phone")}; removing it failed: boom`);
		expect(lines.at(-1)).toBe("dg: removed 2 path(s)");
		expect(existsSync(asideOf("phone"))).toBe(true);
		expect(existsSync(asideOf("daemon"))).toBe(false);
		expect(existsSync(asideOf("channel-review"))).toBe(false);
	});

	test("fails fast with the lock message and removes nothing while another process holds the install lock", async () => {
		putAsides();
		mkdirSync(paths.dataDir, { recursive: true });
		const lockFile = join(paths.dataDir, ".install.lock");
		writeFileSync(lockFile, `${process.pid}:`);
		const lock = withCliLockError((root, fn) => withInstallLock(root, fn, { tries: 1, waitMs: 1 }));
		const lines: string[] = [];
		let failure: string | undefined;
		let code: number | undefined;

		try {
			code = await runClean(paths, { lock, log: (line: string) => void lines.push(line) });
		} catch (error) {
			failure = (error as Error).message;
		}

		expect(failure ?? lines.join("\n")).toContain("is held");
		if (failure === undefined) expect(code).not.toBe(0);
		for (const name of ["daemon", "phone", "channel-review"] as const) expect(existsSync(asideOf(name))).toBe(true);
	});

	test("calls no stop hook, no verify hook and removes no live folder", async () => {
		putLiveFolders();
		putAsides();
		const calls: string[] = [];
		const spy = (key: string) => () => {
			calls.push(key);
			return key.endsWith("verify") ? [] : "stopped";
		};
		const ensure = (target: DgPaths, hooks: object) =>
			ensureLayout(target, {
				...hooks,
				"daemon.stop": spy("daemon.stop"),
				"phone.stop": spy("phone.stop"),
				"phone.verify": spy("phone.verify"),
			} as never);

		await run(paths, { ensure });

		expect(calls).toEqual([]);
		for (const name of ["daemon", "phone", "channel-review"] as const) expect(existsSync(liveOf(name))).toBe(true);
	});
});

describe("runClean legacy home", () => {
	test("removes an empty legacy home", async () => {
		mkdirSync(paths.legacyHome, { recursive: true });

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual([`dg: removed ${paths.legacyHome}`, "dg: removed 1 path(s)"]);
		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("keeps a legacy home that holds only a dg-ai folder, with no line", async () => {
		mkdirSync(join(paths.legacyHome, "dg-ai-extension"), { recursive: true });

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual(["dg: nothing to clean"]);
		expect(existsSync(join(paths.legacyHome, "dg-ai-extension"))).toBe(true);
	});

	test("keeps a legacy home that holds only a dotfile, with no line", async () => {
		putFile(join(paths.legacyHome, ".notes"));

		const { lines } = await run(paths);

		expect(lines).toEqual(["dg: nothing to clean"]);
		expect(existsSync(join(paths.legacyHome, ".notes"))).toBe(true);
	});

	test("does not remove a symlink at the legacy home that points to an empty folder", async () => {
		const target = join(dir, "elsewhere");
		mkdirSync(target, { recursive: true });
		mkdirSync(dirname(paths.legacyHome), { recursive: true });
		symlinkSync(target, paths.legacyHome);

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual(["dg: nothing to clean"]);
		expect(lstatSync(paths.legacyHome).isSymbolicLink()).toBe(true);
	});
});

posix("runClean bin launchers", () => {
	const legacyBin = () => join(paths.legacyHome, "bin");

	test("removes a bin that holds only the notice launchers, then the empty legacy home, in order", async () => {
		putLaunchers(legacyBin());

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual([
			`dg: removed ${legacyBin()}`,
			noticeLine(),
			`dg: removed ${paths.legacyHome}`,
			"dg: removed 2 path(s)",
		]);
		expect(existsSync(paths.legacyHome)).toBe(false);
	});

	test("names the launchers in program order whatever order the file system lists them", async () => {
		putLaunchers(legacyBin());
		const readdir = (path: string): string[] => {
			const names = readdirSync(path);
			return path === legacyBin() ? names.reverse() : names;
		};

		const { lines } = await run(paths, { readdir });

		expect(lines).toContain(noticeLine());
	});

	test("removes bin with its notice and keeps a legacy home that holds a dg-ai folder", async () => {
		putLaunchers(legacyBin());
		mkdirSync(join(paths.legacyHome, "dg-ai-extension"), { recursive: true });

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual([`dg: removed ${legacyBin()}`, noticeLine(), "dg: removed 1 path(s)"]);
		expect(existsSync(legacyBin())).toBe(false);
		expect(existsSync(join(paths.legacyHome, "dg-ai-extension"))).toBe(true);
		expect(existsSync(paths.legacyHome)).toBe(true);
	});

	test("removes an empty bin with only the removed line and no notice", async () => {
		mkdirSync(legacyBin(), { recursive: true });

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual([`dg: removed ${legacyBin()}`, `dg: removed ${paths.legacyHome}`, "dg: removed 2 path(s)"]);
	});

	test("keeps a set-aside that becomes used between the plan and the removal", async () => {
		putAsides();
		let calls = 0;
		const unused = (path: string) => {
			if (path === asideOf("daemon")) return ++calls === 1;
			return true;
		};
		const removed: string[] = [];

		const { lines } = await run(paths, {
			unused,
			removeTree: (path: string) => void removed.push(path),
		});

		expect(removed).not.toContain(asideOf("daemon"));
		expect(lines).toContain(`dg: kept ${asideOf("daemon")}; it holds data`);
	});

	test("keeps a bin that gains a foreign file between the plan and the removal", async () => {
		putLaunchers(legacyBin());
		const realReaddir = readdirSync;
		let binReads = 0;
		const readdir = (path: string): string[] => {
			if (path === legacyBin() && ++binReads === 2) return [...realReaddir(path), "notes.txt"];
			return realReaddir(path);
		};

		const { lines } = await run(paths, { readdir });

		expect(existsSync(legacyBin())).toBe(true);
		expect(lines).toContain(`dg: kept ${legacyBin()}; it holds files that are not dg launchers: notes.txt`);
	});

	test("keeps a bin that holds a file that is not a launcher, with every launcher and no notice", async () => {
		putLaunchers(legacyBin());
		putFile(join(legacyBin(), "notes.txt"));

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual([
			`dg: kept ${legacyBin()}; it holds files that are not dg launchers: notes.txt`,
			"dg: nothing to clean",
		]);
		for (const name of PROGRAMS) expect(existsSync(join(legacyBin(), name))).toBe(true);
		expect(existsSync(paths.legacyHome)).toBe(true);
	});

	test("uses the .cmd names on win32: removes a bin of three .cmd files and keeps one with the bare names", async () => {
		putLaunchers(legacyBin(), "win32");

		const removed = await run(paths, { platform: "win32" });

		expect(removed.code).toBe(0);
		expect(removed.lines).toContain(`dg: removed ${legacyBin()}`);
		expect(removed.lines).toContain(noticeLine("win32"));
		expect(existsSync(legacyBin())).toBe(false);

		putFile(join(legacyBin(), "dg-skills"));
		const kept = await run({ ...paths }, { platform: "win32" });

		expect(kept.lines).toContain(`dg: kept ${legacyBin()}; it holds files that are not dg launchers: dg-skills`);
		expect(existsSync(join(legacyBin(), "dg-skills"))).toBe(true);
	});

	test("never reads or removes bin when it is the live launcher folder under a flat DG_HOME", async () => {
		const flat = resolveDgPaths({ platform: "linux", homeDir: home, env: { DG_HOME: join(dir, "dg-home") } });
		putLaunchers(flat.binDir);
		const reads: string[] = [];
		const readdir = (path: string): string[] => {
			reads.push(path);
			return readdirSync(path);
		};

		const { code, lines } = await run(flat, { readdir });

		expect(code).toBe(0);
		expect(reads).not.toContain(flat.binDir);
		expect(lines).not.toContain(noticeLine());
		expect(lines.some((line) => line.includes(flat.binDir))).toBe(false);
		for (const name of PROGRAMS) expect(existsSync(join(flat.binDir, name))).toBe(true);
	});

	test("lets syncCompatLaunchers create no legacy bin after clean removed it", async () => {
		putLaunchers(legacyBin());
		await run(paths);

		syncCompatLaunchers(paths, "1.45.0");

		expect(existsSync(legacyBin())).toBe(false);
		expect(existsSync(paths.legacyHome)).toBe(false);
	});
});

describe("runClean refusal", () => {
	test("refuses with the has-not-moved text for a legacy phone folder that no hook moves", async () => {
		putFile(join(paths.legacyHome, "phone", "phone.db"));
		putAsides();
		const expected = blockedText((await idleResult()).phone as never);

		const { code, lines } = await run(paths);

		expect(code).toBe(1);
		expect(expected).toContain("has not moved");
		expect(lines).toContain(expected);
		expect(lines.at(-1)).toBe("dg: cleaned nothing; fix the lines above, then run dg-skills clean again");
		for (const name of ["daemon", "phone", "channel-review"] as const) expect(existsSync(asideOf(name))).toBe(true);
	});

	test("refuses with the kept text for a daemon outcome blocked by a live writer", async () => {
		putAsides();
		const base = await idleResult();
		const outcome = { kind: "blocked", reason: "live-writer", from: join(paths.legacyHome, "daemon"), to: paths.daemonDir } as const;
		const ensure = async () => ({ ...base, daemon: { ...outcome, fix: blockedText(outcome) } }) as LayoutResult;

		const { code, lines } = await run(paths, { ensure });

		expect(code).toBe(1);
		expect(lines).toContain(blockedText(outcome));
		expect(lines.at(-1)).toBe("dg: cleaned nothing; fix the lines above, then run dg-skills clean again");
		for (const name of ["daemon", "phone", "channel-review"] as const) expect(existsSync(asideOf(name))).toBe(true);
	});

	test("refuses for a daemon copy that is incomplete and removes nothing", async () => {
		putAsides();
		const base = await idleResult();
		const from = join(paths.legacyHome, "daemon");
		const ensure = async () =>
			({ ...base, daemon: { kind: "kept", reason: "copy-incomplete", from, to: paths.daemonDir } }) as LayoutResult;

		const { code, lines } = await run(paths, { ensure });

		expect(code).toBe(1);
		expect(lines).toContain(`dg: kept ${from}; its copy at ${paths.daemonDir} no longer holds every file`);
		expect(lines.at(-1)).toBe("dg: cleaned nothing; fix the lines above, then run dg-skills clean again");
		for (const name of ["daemon", "phone", "channel-review"] as const) expect(existsSync(asideOf(name))).toBe(true);
	});

	test("still removes the set-asides and returns 0 when a daemon outcome is scheduled", async () => {
		putAsides();
		const base = await idleResult();
		const from = join(paths.legacyHome, "daemon");
		const ensure = async () => ({ ...base, daemon: { kind: "scheduled", from, to: paths.daemonDir } }) as LayoutResult;

		const { code, lines } = await run(paths, { ensure });

		expect(code).toBe(0);
		expect(lines.at(-1)).toBe("dg: removed 3 path(s)");
		for (const name of ["daemon", "phone", "channel-review"] as const) expect(existsSync(asideOf(name))).toBe(false);
	});

	test("prints nothing to clean after the ensure step removed a complete pending copy", async () => {
		const from = join(paths.legacyHome, "grants");
		putFile(join(from, "grant.json"), "{}");
		putFile(join(paths.grantsDir, "grant.json"), "{}");
		mkdirSync(join(paths.legacyHome, "dg-ai-extension"), { recursive: true });
		writeFileSync(
			join(paths.legacyHome, ".pending-removal.json"),
			JSON.stringify([{ name: "grants", from, to: paths.grantsDir }]),
		);

		const { code, lines } = await run(paths);

		expect(code).toBe(0);
		expect(lines).toEqual([`dg: removed ${from}; its copy at ${paths.grantsDir} was complete`, "dg: nothing to clean"]);
		expect(existsSync(from)).toBe(false);
		expect(existsSync(join(paths.grantsDir, "grant.json"))).toBe(true);
	});
});

describe("planClean", () => {
	test("returns the same plan for the same snapshot twice and calls no seam", () => {
		const live = liveOf("daemon");
		const aside = `${live}.empty-1700000000000`;
		const snapshot: CleanSnapshot = {
			asides: { daemon: { live, names: [basename(aside)] } },
			unused: { [aside]: true },
			bin: { path: join(paths.legacyHome, "bin"), names: [...PROGRAMS] },
			home: { path: paths.legacyHome, kind: "directory", names: ["bin"] },
			platform: "linux",
		};
		const frozen = structuredClone(snapshot);
		const stat = spyOn(fs, "lstatSync");
		const read = spyOn(fs, "readdirSync");

		const first = planClean(moveEntries, snapshot);
		const second = planClean(moveEntries, snapshot);

		expect(second).toEqual(first);
		expect(snapshot).toEqual(frozen);
		expect(first.map((action) => action.kind)).toEqual(["removeAside", "removeBin", "removeLegacyHome"]);
		expect(planClean.length).toBe(2);
		expect(stat).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		stat.mockRestore();
		read.mockRestore();
	});
});

const doctorContext = (): DoctorContext => ({
	home,
	env: {},
	paths,
	installedVersion: "dev",
	memo: (_key, make) => make(),
});

posix("pendingCleanPaths and the leftovers doctor check", () => {
	test("names an unused set-aside folder and warns with the clean fix", async () => {
		mkdirSync(asideOf("daemon"), { recursive: true });

		expect(pendingCleanPaths(paths)).toEqual([asideOf("daemon")]);
		const result = await cleanChecks[0]?.run(doctorContext());
		expect(result).toMatchObject({ status: "warn", fix: "dg-skills clean" });
	});

	test("passes when the old home holds only folders that clean keeps", async () => {
		mkdirSync(join(paths.legacyHome, "dg-ai-notes"), { recursive: true });

		expect(pendingCleanPaths(paths)).toEqual([]);
		const result = await cleanChecks[0]?.run(doctorContext());
		expect(result).toMatchObject({ status: "ok" });
		expect(existsSync(join(paths.legacyHome, "dg-ai-notes"))).toBe(true);
	});
});
