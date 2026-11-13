import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withInstallLock, withInstallLockSync } from "@dg/common/node";
import { makeTempDir, removeTempDirs } from "./utils/temp-dirs";

let root: string;

beforeEach(() => {
	root = join(makeTempDir("dg-install-lock-"), "root");
	mkdirSync(root, { recursive: true });
});

afterEach(removeTempDirs);

const lockPath = () => join(root, ".install.lock");
const body = (pid: number): string => `${pid}::token`;
const FAST = { tries: 5, waitMs: 5 };

function deadPid(): number {
	const child = Bun.spawnSync(["true"]);
	return child.pid;
}

describe("withInstallLock", () => {
	test("runs critical sections one at a time and removes the lock afterwards", async () => {
		const order: string[] = [];
		const section = (name: string) => async () => {
			order.push(`${name}:start`);
			await Bun.sleep(30);
			order.push(`${name}:end`);
		};

		await Promise.all([
			withInstallLock(root, section("a"), { tries: 100, waitMs: 5 }),
			withInstallLock(root, section("b"), { tries: 100, waitMs: 5 }),
		]);

		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("releases the lock when the section throws", async () => {
		await expect(
			withInstallLock(root, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(existsSync(lockPath())).toBe(false);
	});

	test("takes over a lock whose owner process is dead", async () => {
		writeFileSync(lockPath(), body(deadPid()));

		const result = await withInstallLock(root, () => "ran", FAST);

		expect(result).toBe("ran");
	});

	test("keeps a lock whose live owner is older than any age limit", async () => {
		writeFileSync(lockPath(), body(process.pid));
		const old = new Date(Date.now() - 24 * 3_600_000);
		utimesSync(lockPath(), old, old);

		await expect(withInstallLock(root, () => "ran", FAST)).rejects.toThrow(
			`pid ${process.pid}`,
		);
		expect(readFileSync(lockPath(), "utf8")).toBe(body(process.pid));
	});

	test.skipIf(process.platform !== "linux")(
		"takes over a lock whose pid was reused by a process with another start time",
		async () => {
			writeFileSync(lockPath(), `${process.pid}:1:reused`);

			expect(await withInstallLock(root, () => "ran", FAST)).toBe("ran");
		},
	);

	test("takes over an empty lock only after the grace period", async () => {
		writeFileSync(lockPath(), "");
		await expect(withInstallLock(root, () => "ran", FAST)).rejects.toThrow(
			lockPath(),
		);

		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath(), old, old);
		expect(await withInstallLock(root, () => "ran", FAST)).toBe("ran");
	});

	test("fails with a message naming the lock and the owner pid when a live owner keeps it", async () => {
		writeFileSync(lockPath(), body(process.pid));

		await expect(withInstallLock(root, () => "ran", FAST)).rejects.toThrow(
			lockPath(),
		);
		expect(readFileSync(lockPath(), "utf8")).toBe(body(process.pid));
	});

	test("never removes a live lock that replaced the stale one it observed", async () => {
		writeFileSync(lockPath(), body(deadPid()));
		const replacement = body(process.pid);
		let replaced = false;

		await expect(
			withInstallLock(root, () => "ran", {
				...FAST,
				onStaleObserved: () => {
					if (replaced) return;
					replaced = true;
					rmSync(lockPath());
					writeFileSync(lockPath(), replacement);
				},
			}),
		).rejects.toThrow(lockPath());

		expect(readFileSync(lockPath(), "utf8")).toBe(replacement);
	});

	test("takes over a crashed reclaim guard", async () => {
		writeFileSync(lockPath(), body(deadPid()));
		writeFileSync(`${lockPath()}.reclaim`, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${lockPath()}.reclaim`, old, old);

		expect(await withInstallLock(root, () => "ran", FAST)).toBe("ran");
	});
});

describe("withInstallLockSync", () => {
	test("runs fn, returns its value and removes the lock", () => {
		expect(withInstallLockSync(root, () => 7)).toBe(7);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("throws when a live owner holds the lock", () => {
		writeFileSync(lockPath(), body(process.pid));
		expect(() => withInstallLockSync(root, () => 1, FAST)).toThrow("is held");
		expect(readFileSync(lockPath(), "utf8")).toBe(body(process.pid));
	});

	test("reclaims a lock whose owner is dead", () => {
		writeFileSync(lockPath(), body(deadPid()));
		expect(withInstallLockSync(root, () => "ok", FAST)).toBe("ok");
	});
});
