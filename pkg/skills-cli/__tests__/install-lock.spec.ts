import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withInstallLock } from "../src/install/lock";
import { scratch, type Scratch } from "./runtime-bundle-fixtures";

let sandbox: Scratch;

beforeEach(() => {
	sandbox = scratch("install-lock");
});

afterEach(() => {
	sandbox.cleanup();
});

const lockPath = () => join(sandbox.root, ".install.lock");
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
			withInstallLock(sandbox.root, section("a"), { tries: 100, waitMs: 5 }),
			withInstallLock(sandbox.root, section("b"), { tries: 100, waitMs: 5 }),
		]);

		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("releases the lock when the section throws", async () => {
		await expect(
			withInstallLock(sandbox.root, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(existsSync(lockPath())).toBe(false);
	});

	test("takes over a lock whose owner process is dead", async () => {
		writeFileSync(lockPath(), body(deadPid()));

		const result = await withInstallLock(sandbox.root, () => "ran", FAST);

		expect(result).toBe("ran");
	});

	test("keeps a lock whose live owner is older than any age limit", async () => {
		writeFileSync(lockPath(), body(process.pid));
		const old = new Date(Date.now() - 24 * 3_600_000);
		utimesSync(lockPath(), old, old);

		await expect(withInstallLock(sandbox.root, () => "ran", FAST)).rejects.toThrow(`pid ${process.pid}`);
		expect(readFileSync(lockPath(), "utf8")).toBe(body(process.pid));
	});

	test.skipIf(process.platform !== "linux")("takes over a lock whose pid was reused by a process with another start time", async () => {
		writeFileSync(lockPath(), `${process.pid}:1:reused`);

		expect(await withInstallLock(sandbox.root, () => "ran", FAST)).toBe("ran");
	});

	test("takes over an empty lock only after the grace period", async () => {
		writeFileSync(lockPath(), "");
		await expect(withInstallLock(sandbox.root, () => "ran", FAST)).rejects.toThrow(lockPath());

		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath(), old, old);
		expect(await withInstallLock(sandbox.root, () => "ran", FAST)).toBe("ran");
	});

	test("fails with a message naming the lock and the owner pid when a live owner keeps it", async () => {
		writeFileSync(lockPath(), body(process.pid));

		await expect(withInstallLock(sandbox.root, () => "ran", FAST)).rejects.toThrow(lockPath());
		expect(readFileSync(lockPath(), "utf8")).toBe(body(process.pid));
	});

	test("never removes a live lock that replaced the stale one it observed", async () => {
		writeFileSync(lockPath(), body(deadPid()));
		const replacement = body(process.pid);
		let replaced = false;

		await expect(
			withInstallLock(sandbox.root, () => "ran", {
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

		expect(await withInstallLock(sandbox.root, () => "ran", FAST)).toBe("ran");
	});
});
