import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { protoScratchPath } from "../src/utils/proto-paths";
import { extStatus } from "../src/prototype/index";

const written: string[] = [];

afterEach(() => {
	for (const path of written.splice(0)) rmSync(dirname(path), { recursive: true, force: true });
});

function writeVerdict(name: string, mtime: Date): string {
	const path = protoScratchPath(name, "verdict.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			slug: name,
			action: "approve",
			selectedKey: "detailed",
			ts: 1_721_234_568_000,
		}),
	);
	utimesSync(path, mtime, mtime);
	written.push(path);
	return path;
}

function writeReload(name: string, mtime: Date): string {
	const reloadPath = join(
		dirname(protoScratchPath(name, "verdict.json")),
		".reload",
	);
	mkdirSync(dirname(reloadPath), { recursive: true });
	writeFileSync(reloadPath, `${mtime.getTime()}\n`);
	utimesSync(reloadPath, mtime, mtime);
	written.push(reloadPath);
	return reloadPath;
}

describe("extStatus", () => {
	test("returns undefined with no scratch verdict and no .reload to compare against", () => {
		const noReload = join(
			"/nonexistent-reload-dir-for-ext-status-tests",
			".reload",
		);
		expect(
			extStatus("no-such-prototype-ext-status-demo", noReload),
		).toBeUndefined();
	});

	test("reports a scratch verdict with no .reload to compare against", () => {
		const name = "ext-status-scratch-fallback-demo";
		writeVerdict(name, new Date());
		const noReload = join(
			"/nonexistent-reload-dir-for-ext-status-tests",
			".reload",
		);
		expect(extStatus(name, noReload)).toBe("approve:detailed");
	});

	test("ignores a scratch verdict older than the current local session's .reload", () => {
		const name = "ext-status-stale-session-demo";
		writeVerdict(name, new Date(1_000_000));
		const reloadPath = writeReload(name, new Date(2_000_000));
		expect(extStatus(name, reloadPath)).toBeUndefined();
	});

	test("still reports a scratch verdict newer than the current local session's .reload", () => {
		const name = "ext-status-fresh-session-demo";
		const reloadPath = writeReload(name, new Date(1_000_000));
		writeVerdict(name, new Date(2_000_000));
		expect(extStatus(name, reloadPath)).toBe("approve:detailed");
	});
});
