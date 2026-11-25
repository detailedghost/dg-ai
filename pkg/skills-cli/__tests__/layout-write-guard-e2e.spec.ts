import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEnv, runCli, writeReleaseServer } from "./release-fixtures";
import { skillsEntry } from "./inbox-cli-harness";

const posix = describe.skipIf(process.platform === "win32" || process.getuid?.() === 0);

const PIN = "1.27.0";

let directory: string;
let home: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "dg-write-guard-e2e-"));
	home = join(directory, "home");
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function unreadable(relative: string): string {
	const file = join(home, relative);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, "old");
	chmodSync(file, 0);
	return file;
}

posix("dg commands after a legacy entry failed to move", () => {
	test("install writes no data/bin folder when the legacy lib folder cannot be copied", async () => {
		unreadable("lib/old/file");
		writeFileSync(join(directory, "fetch.log"), "");
		const { preload } = writeReleaseServer(directory, join(directory, "fetch.log"), PIN);

		const result = await runCli(
			["bun", "--preload", preload, skillsEntry, "install", "--agent-only", "--version", PIN],
			installEnv(home),
		);

		expect(result.code).not.toBe(0);
		expect(existsSync(join(home, "data", "bin"))).toBe(false);
		expect(existsSync(join(home, "data", "lib"))).toBe(false);
		expect(existsSync(join(home, "bin", "dg"))).toBe(false);
	});
});
