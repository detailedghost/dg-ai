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
		writeFileSync(lockPath(), `${deadPid()}:old`);

		const result = await withInstallLock(sandbox.root, () => "ran", FAST);

		expect(result).toBe("ran");
	});

	test("takes over a lock older than the stale age even when its pid is alive", async () => {
		writeFileSync(lockPath(), `${process.pid}:old`);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath(), old, old);

		const result = await withInstallLock(sandbox.root, () => "ran", { ...FAST, staleMs: 1000 });

		expect(result).toBe("ran");
	});

	test("fails with a message naming the lock when a live owner keeps it", async () => {
		writeFileSync(lockPath(), `${process.pid}:live`);

		await expect(withInstallLock(sandbox.root, () => "ran", FAST)).rejects.toThrow(lockPath());
		expect(readFileSync(lockPath(), "utf8")).toBe(`${process.pid}:live`);
	});

	test("never removes a live lock that replaced the stale one it observed", async () => {
		writeFileSync(lockPath(), `${deadPid()}:old`);
		const replacement = `${process.pid}:replacement`;
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
		writeFileSync(lockPath(), `${deadPid()}:old`);
		writeFileSync(`${lockPath()}.reclaim`, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${lockPath()}.reclaim`, old, old);

		expect(await withInstallLock(sandbox.root, () => "ran", FAST)).toBe("ran");
	});
});
