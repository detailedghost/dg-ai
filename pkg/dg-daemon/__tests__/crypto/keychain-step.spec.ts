import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { ensureLayout, type LayoutResult, type Outcome } from "@dg/common/node/layout";
import { keychainAccountsForPaths } from "../../src/crypto/keychain-backends";
import { decideKeychainMove } from "../../src/crypto/keychain-step";
import { daemonLayoutHooks } from "../../src/layout-hooks";
import { type FakeKeychain, type FakeOptions, fakeKeychain, OTHER_SECRET, SECRET } from "../utils/fake-keychain";

type StepResult = "moved" | "kept" | "absent";
type Step = { keychainMove: (paths: DgPaths) => Promise<StepResult> };

const ENDS = { from: "legacy/daemon", to: "state/daemon" };
const OUTCOMES = {
	absent: { ...ENDS, kind: "absent" },
	moved: { ...ENDS, kind: "moved", stopped: false },
	kept: { ...ENDS, kind: "kept", reason: "target-used" },
	setAside: { ...ENDS, kind: "setAside", asideTo: "state/daemon.empty-1", stopped: false },
	blocked: { ...ENDS, kind: "blocked", reason: "live-writer", fix: "dg: kept legacy/daemon" },
	failed: { ...ENDS, kind: "failed", error: "copy failed" },
} as const satisfies Record<string, Outcome>;

let home: string;
let warnings: string[];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-keychain-step-"));
	warnings = [];
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function freshPaths(): DgPaths {
	return resolveDgPaths({ platform: "linux", homeDir: home, env: {} });
}

async function prime(paths: DgPaths, daemon: keyof typeof OUTCOMES = "absent"): Promise<DgPaths> {
	const result = { daemon: OUTCOMES[daemon] } as LayoutResult;
	const work = { planLayout: () => ({}), snapshot: () => ({}), mutates: () => false, applyLayout: () => result };
	await ensureLayout(paths, { readdir: () => ["daemon"], load: async () => work as never });
	return paths;
}

type Pair = { current: FakeKeychain; legacy: FakeKeychain };

function stepOf(
	pair: Pair,
	deps: { platform?: NodeJS.Platform; env?: Record<string, string | undefined> } = {},
): { step: Step; built: () => number } {
	let built = 0;
	const hooks = daemonLayoutHooks({
		platform: deps.platform ?? "linux",
		...(deps.env ? { env: deps.env } : {}),
		warn: (line: string) => warnings.push(line),
		backends: () => {
			built += 1;
			return { current: pair.current.backend, legacy: pair.legacy.backend };
		},
	} as Parameters<typeof daemonLayoutHooks>[0]);
	return { step: hooks as unknown as Step, built: () => built };
}

function pairOf(current: string | undefined, legacy: string | undefined, options: { current?: FakeOptions; legacy?: FakeOptions } = {}): Pair {
	return {
		current: fakeKeychain(current, { label: "current", ...options.current }),
		legacy: fakeKeychain(legacy, { label: "legacy", ...options.legacy }),
	};
}

async function run(
	pair: Pair,
	{ daemon = "absent", ...deps }: { daemon?: keyof typeof OUTCOMES; platform?: NodeJS.Platform; env?: Record<string, string | undefined> } = {},
) {
	const paths = await prime(freshPaths(), daemon);
	const { step, built } = stepOf(pair, deps);
	const result = await step.keychainMove(paths);
	return { result, paths, built };
}

const differsText = (current: string) =>
	`dg: keychain secret chat-store-kek differs between the old and the new account; dg reads the new account. If the daemon refuses the key, delete the entry ${current} and start the daemon again`;
const KEEP_OLD = "dg keeps the old entry and reads it from the old account";

describe("keychainMove decision table", () => {
	it("copies the legacy key into the absent current account, reads it back, then deletes the legacy entry", async () => {
		const events: string[] = [];
		const pair = pairOf(undefined, SECRET, { current: { events }, legacy: { events } });

		const { result } = await run(pair);

		expect(result).toBe("moved");
		expect(pair.current.count("store")).toBe(1);
		expect(pair.current.value).toBe(SECRET);
		expect(pair.legacy.count("remove")).toBe(1);
		expect(pair.legacy.count("store")).toBe(0);
		expect(pair.current.calls).not.toContain("remove");
		expect(warnings).toEqual([]);
		const lastCurrentRead = events.lastIndexOf("current.lookup");
		expect(lastCurrentRead).toBeGreaterThan(events.indexOf("current.store"));
		expect(events.indexOf("legacy.remove")).toBeGreaterThan(lastCurrentRead);
	});

	it("deletes the legacy entry without a store when the current account already holds the same key", async () => {
		const pair = pairOf(SECRET, SECRET);

		const { result } = await run(pair);

		expect(result).toBe("moved");
		expect(pair.current.count("store")).toBe(0);
		expect(pair.legacy.count("remove")).toBe(1);
		expect(pair.current.calls).not.toContain("remove");
		expect(warnings).toEqual([]);
	});

	it.each(["absent", "moved", "kept"] as const)(
		"keeps both entries and warns once with the entry to delete when the keys differ and the daemon outcome is %s",
		async (daemon) => {
			const pair = pairOf(OTHER_SECRET, SECRET);

			const { result, paths } = await run(pair, { daemon });

			expect(result).toBe("kept");
			expect(pair.current.count("store")).toBe(0);
			expect(pair.current.calls).not.toContain("remove");
			expect(pair.legacy.count("remove")).toBe(0);
			expect(pair.current.value).toBe(OTHER_SECRET);
			expect(pair.legacy.value).toBe(SECRET);
			expect(warnings).toEqual([differsText(keychainAccountsForPaths(paths).current)]);
		},
	);

	it("overwrites the current account with the legacy key when the keys differ and this run set the daemon store aside", async () => {
		const pair = pairOf(OTHER_SECRET, SECRET);

		const { result } = await run(pair, { daemon: "setAside" });

		expect(result).toBe("moved");
		expect(pair.current.count("store")).toBe(1);
		expect(pair.current.value).toBe(SECRET);
		expect(pair.legacy.count("remove")).toBe(1);
		expect(pair.current.calls).not.toContain("remove");
		expect(warnings).toEqual([]);
	});

	it("overwrites the occupied current account through a store that updates in place", async () => {
		const pair = pairOf(OTHER_SECRET, SECRET, { current: { storeUpdates: true } });

		const { result } = await run(pair, { daemon: "setAside" });

		expect(result).toBe("moved");
		expect(pair.current.value).toBe(SECRET);
		expect(warnings).toEqual([]);
	});

	it.each([
		["the store fails", { storeUpdates: false }],
		["the read-back differs", { storeAs: OTHER_SECRET }],
	] as const)("warns that dg reads the new account and names the entry to delete when %s after a setAside", async (_name, options) => {
		const pair = pairOf(OTHER_SECRET, SECRET, { current: options });

		const { result, paths } = await run(pair, { daemon: "setAside" });

		expect(result).toBe("kept");
		expect(pair.legacy.count("remove")).toBe(0);
		expect(warnings).toEqual([differsText(keychainAccountsForPaths(paths).current)]);
	});

	it("returns absent and writes nothing when there is no legacy entry, after one legacy lookup", async () => {
		const pair = pairOf(SECRET, undefined);

		const { result } = await run(pair);

		expect(result).toBe("absent");
		expect(pair.legacy.count("lookup")).toBe(1);
		expect(pair.current.count("lookup")).toBe(0);
		expect(pair.legacy.count("store") + pair.legacy.count("remove")).toBe(0);
		expect(pair.current.count("store") + pair.current.count("remove")).toBe(0);
		expect(warnings).toEqual([]);
	});

	it("makes no lookup and no remove when the current and legacy account names are equal", async () => {
		const pair = pairOf(SECRET, SECRET);
		const paths = { ...(await prime(freshPaths())), stateDir: join(homedir(), ".dg") };
		const accounts = keychainAccountsForPaths(paths);
		expect(accounts.current).toBe(accounts.legacy);
		const { step } = stepOf(pair);

		expect(await step.keychainMove(paths)).toBe("absent");

		expect(pair.current.calls).toEqual([]);
		expect(pair.legacy.calls).toEqual([]);
	});
});

describe("keychainMove failures keep a readable copy", () => {
	it("keeps the legacy entry and warns once when the store succeeds but the read-back differs", async () => {
		const pair = pairOf(undefined, SECRET, { current: { storeAs: OTHER_SECRET } });

		const { result } = await run(pair);

		expect(result).toBe("kept");
		expect(pair.legacy.count("remove")).toBe(0);
		expect(pair.legacy.value).toBe(SECRET);
		expect(warnings).toEqual([`dg: keychain secret chat-store-kek did not read back the same from the new account; ${KEEP_OLD}`]);
	});

	it("reports moved with the could-not-be-deleted warning when the legacy delete fails after a verified copy", async () => {
		const pair = pairOf(undefined, SECRET, { legacy: { removeFails: true } });

		const { result } = await run(pair);

		expect(result).toBe("moved");
		expect(pair.current.value).toBe(SECRET);
		expect(pair.legacy.value).toBe(SECRET);
		expect(warnings).toEqual([
			"dg: keychain secret chat-store-kek moved to the new account, but the old entry could not be deleted; dg reads the new account, and a copy stays in the old one",
		]);
	});

	it("keeps both entries and warns once when the legacy entry is unreachable", async () => {
		const pair = pairOf(undefined, undefined, { legacy: { lookupUnreachable: true } });

		const { result } = await run(pair);

		expect(result).toBe("kept");
		expect(pair.current.count("store") + pair.current.count("remove")).toBe(0);
		expect(pair.legacy.count("store") + pair.legacy.count("remove")).toBe(0);
		expect(warnings).toEqual([
			"dg: keychain secret chat-store-kek could not be read from the old account; dg leaves both accounts as they are",
		]);
	});

	it("keeps both entries and warns once when the current account cannot be written", async () => {
		const pair = pairOf(undefined, SECRET, { current: { storeFails: true } });

		const { result } = await run(pair);

		expect(result).toBe("kept");
		expect(pair.legacy.count("remove")).toBe(0);
		expect(pair.legacy.value).toBe(SECRET);
		expect(warnings).toEqual([`dg: keychain secret chat-store-kek could not be written to the new account; ${KEEP_OLD}`]);
	});

	it("keeps both entries and warns once when the current account is unreachable", async () => {
		const pair = pairOf(undefined, SECRET, { current: { lookupUnreachable: true } });

		const { result } = await run(pair);

		expect(result).toBe("kept");
		expect(pair.current.count("store")).toBe(0);
		expect(pair.legacy.count("remove")).toBe(0);
		expect(warnings).toHaveLength(1);
	});
});

describe("keychainMove skips", () => {
	it.each(["blocked", "failed"] as const)("makes no backend call when the daemon outcome is %s", async (daemon) => {
		const pair = pairOf(undefined, SECRET);

		await run(pair, { daemon });

		expect(pair.current.calls).toEqual([]);
		expect(pair.legacy.calls).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("makes no backend call when DG_KEY_SOURCE is file", async () => {
		const pair = pairOf(undefined, SECRET);

		await run(pair, { env: { DG_KEY_SOURCE: "file" } });

		expect(pair.current.calls).toEqual([]);
		expect(pair.legacy.calls).toEqual([]);
	});

	it("makes no backend call on win32 and keeps the key.dpapi bytes through the daemon move", async () => {
		const pair = pairOf(undefined, SECRET);
		const paths = freshPaths();
		const bytes = randomBytes(64);
		mkdirSync(join(paths.legacyHome, "daemon"), { recursive: true });
		writeFileSync(join(paths.legacyHome, "daemon", "key.dpapi"), bytes);
		const { step } = stepOf(pair, { platform: "win32" });
		await ensureLayout(paths, daemonLayoutHooks({ platform: "win32" }));

		await step.keychainMove(paths);

		expect(pair.current.calls).toEqual([]);
		expect(pair.legacy.calls).toEqual([]);
		expect(readFileSync(join(paths.daemonDir, "key.dpapi")).equals(bytes)).toBe(true);
		expect(existsSync(join(paths.legacyHome, "daemon", "key.dpapi"))).toBe(false);
	});

	it("builds no backend when the hooks object is built, only when the step runs", async () => {
		const pair = pairOf(undefined, SECRET);
		const paths = await prime(freshPaths());
		const { step, built } = stepOf(pair);

		expect(built()).toBe(0);
		await step.keychainMove(paths);

		expect(built()).toBeGreaterThan(0);
	});
});

describe("keychainMove secret hygiene", () => {
	const leak = `backend failed for ${SECRET}`;

	it.each([
		["legacy lookup", () => pairOf(undefined, SECRET, { legacy: { rejectWith: leak } })],
		["current lookup", () => pairOf(undefined, SECRET, { current: { rejectWith: leak } })],
		["every call", () => pairOf(undefined, SECRET, { current: { rejectWith: leak }, legacy: { rejectWith: leak } })],
	])("maps a rejecting backend to a kept result without leaking the key (%s)", async (_name, build) => {
		const pair = build();

		const { result } = await run(pair);

		expect(result).toBe("kept");
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.join("\n")).not.toContain(SECRET);
		expect(warnings.join("\n")).not.toContain("backend failed");
	});

	it("does not leak the key when the current store rejects", async () => {
		const pair = pairOf(undefined, SECRET);
		pair.current.backend.store = async () => {
			throw new Error(`store failed for ${SECRET}`);
		};

		const { result } = await run(pair);

		expect(result).toBe("kept");
		expect(pair.legacy.count("remove")).toBe(0);
		expect(warnings.join("\n")).not.toContain(SECRET);
	});

	it("does not leak the key when the legacy remove rejects after a verified copy", async () => {
		const pair = pairOf(undefined, SECRET);
		pair.legacy.backend.remove = async () => {
			throw new Error(`remove failed for ${SECRET}`);
		};

		const { result } = await run(pair);

		expect(result).toBe("moved");
		expect(warnings).toHaveLength(1);
		expect(warnings.join("\n")).not.toContain(SECRET);
	});

	it("never prints either key in the differs warning", async () => {
		const pair = pairOf(OTHER_SECRET, SECRET);

		await run(pair);

		expect(warnings.join("\n")).not.toContain(SECRET);
		expect(warnings.join("\n")).not.toContain(OTHER_SECRET);
	});
});

describe("keychainMove repeat and concurrent runs", () => {
	it("calls the backends once when the step runs twice in one process", async () => {
		const pair = pairOf(undefined, SECRET);
		const paths = await prime(freshPaths());
		const { step } = stepOf(pair);

		await step.keychainMove(paths);
		const lookups = pair.legacy.count("lookup");
		const stores = pair.current.count("store");
		await step.keychainMove(paths);

		expect(lookups).toBe(1);
		expect(pair.legacy.count("lookup")).toBe(lookups);
		expect(pair.current.count("store")).toBe(stores);
		expect(pair.legacy.count("remove")).toBe(1);
	});

	it("leaves one copy and at most one warning when two steps interleave under the install lock", async () => {
		const pair = pairOf(undefined, SECRET, { current: { delayMs: 5 }, legacy: { delayMs: 5 } });
		const base = freshPaths();
		const first = await prime(base);
		const second = await prime({ ...base, legacyHome: join(home, "other-legacy") });
		const { step } = stepOf(pair);

		const results = await Promise.all([step.keychainMove(first), step.keychainMove(second)]);

		expect([...results].sort()).toEqual(["absent", "moved"]);
		expect(pair.current.value).toBe(SECRET);
		expect(pair.legacy.value).toBeUndefined();
		expect(pair.current.count("store")).toBe(1);
		expect(pair.legacy.count("remove")).toBe(1);
		expect(warnings.length).toBeLessThanOrEqual(1);
	});
});

describe("keychainMove platform guards and read-back checks", () => {
	it.each(["blocked", "failed"] as const)("returns kept with no warning when the daemon outcome is %s", async (daemon) => {
		const { result } = await run(pairOf(undefined, SECRET), { daemon });

		expect(result).toBe("kept");
		expect(warnings).toEqual([]);
	});

	it.each([
		["DG_KEY_SOURCE=file", { env: { DG_KEY_SOURCE: "file" } }],
		["win32", { platform: "win32" as const }],
		["freebsd", { platform: "freebsd" as const }],
	])("returns absent with no backend built under %s", async (_name, deps) => {
		const { result, built } = await run(pairOf(undefined, SECRET), deps);

		expect(result).toBe("absent");
		expect(built()).toBe(0);
		expect(warnings).toEqual([]);
	});

	it("runs the move on darwin", async () => {
		const pair = pairOf(undefined, SECRET);

		const { result } = await run(pair, { platform: "darwin" });

		expect(result).toBe("moved");
		expect(pair.current.value).toBe(SECRET);
	});

	it("repeats the kept result without a second warning on the same legacy home", async () => {
		const pair = pairOf(OTHER_SECRET, SECRET);
		const paths = await prime(freshPaths());
		const { step } = stepOf(pair);

		const first = await step.keychainMove(paths);
		const second = await step.keychainMove(paths);

		expect([first, second]).toEqual(["kept", "kept"]);
		expect(warnings).toHaveLength(1);
		expect(pair.legacy.count("lookup")).toBe(1);
	});

	it("keeps the legacy entry when the read-back finds the current account absent", async () => {
		const pair = pairOf(undefined, SECRET, { current: { reads: [{ status: "absent" }, { status: "absent" }] } });

		const { result } = await run(pair);

		expect(result).toBe("kept");
		expect(pair.legacy.count("remove")).toBe(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("did not read back the same");
	});

	it("keeps the legacy entry when the read-back is unreachable", async () => {
		const pair = pairOf(undefined, SECRET, { current: { reads: [{ status: "absent" }, { status: "unreachable" }] } });

		const { result } = await run(pair);

		expect(result).toBe("kept");
		expect(pair.legacy.count("remove")).toBe(0);
		expect(warnings).toHaveLength(1);
	});

	it("warns once about the delete when the legacy remove is unreachable and still returns moved", async () => {
		const pair = pairOf(SECRET, SECRET, { legacy: { removeFails: true } });

		const { result } = await run(pair);

		expect(result).toBe("moved");
		expect(pair.current.count("store")).toBe(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not be deleted");
	});

	it.each([
		["store fails", () => pairOf(undefined, SECRET, { current: { storeFails: true } })],
		["read-back differs", () => pairOf(undefined, SECRET, { current: { storeAs: OTHER_SECRET } })],
		["remove fails", () => pairOf(undefined, SECRET, { legacy: { removeFails: true } })],
		["keys differ", () => pairOf(OTHER_SECRET, SECRET)],
		["legacy unreadable", () => pairOf(undefined, SECRET, { legacy: { lookupUnreachable: true } })],
	])("prints no key in any warning line when %s", async (_name, build) => {
		await run(build());

		expect(warnings.length).toBeGreaterThan(0);
		for (const line of warnings) {
			expect(line).not.toContain(SECRET);
			expect(line).not.toContain(OTHER_SECRET);
		}
	});
});

describe("decideKeychainMove", () => {
	const found = (keyBase64: string) => ({ status: "found" as const, keyBase64 });
	const absent = { status: "absent" as const };
	const unreachable = { status: "unreachable" as const };

	it.each([
		["legacy absent", absent, absent, undefined, { kind: "skip" }],
		["legacy unreadable", absent, unreachable, undefined, { kind: "keep", reason: "legacy-unreadable" }],
		["current absent", absent, found(SECRET), undefined, { kind: "copy", key: SECRET }],
		["current unreachable", unreachable, found(SECRET), undefined, { kind: "keep", reason: "current-unwritable" }],
		["same key", found(SECRET), found(SECRET), undefined, { kind: "drop" }],
		["differs", found(OTHER_SECRET), found(SECRET), "moved", { kind: "keep", reason: "differs" }],
		["differs after setAside", found(OTHER_SECRET), found(SECRET), "setAside", { kind: "copy", key: SECRET }],
	] as const)("picks the action for %s", (_name, current, legacy, daemonOutcome, expected) => {
		expect(decideKeychainMove({ current, legacy, daemonOutcome })).toEqual(expected);
	});
});
