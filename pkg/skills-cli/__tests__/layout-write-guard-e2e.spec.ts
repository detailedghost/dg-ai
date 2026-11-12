import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEnv, runCli, writeReleaseServer } from "./runtime-bundle-fixtures";
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

posix("dg-skills commands after a legacy entry failed to move", () => {
	for (const entry of ["lib", "runtime"]) {
		test(`install writes no data/${entry} folder when the legacy ${entry} folder cannot be copied`, async () => {
			unreadable(`${entry}/old/file`);
			writeFileSync(join(directory, "fetch.log"), "");
			const { preload } = writeReleaseServer(directory, join(directory, "fetch.log"), PIN);

			const result = await runCli(
				["bun", "--preload", preload, skillsEntry, "install", "--agent-only", "--version", PIN],
				installEnv(home),
			);

			expect(result.code).not.toBe(0);
			expect(existsSync(join(home, "data", entry))).toBe(false);
			expect(existsSync(join(home, "data", "lib", "current"))).toBe(false);
		});
	}

	test("channel-review env writes no config.json when the legacy channel-review config cannot be copied", async () => {
		unreadable("channel-review/config.json");

		const result = await runCli(["bun", skillsEntry, "channel-review", "env", "prod"], installEnv(home));

		expect(result.code).not.toBe(0);
		expect(existsSync(join(home, "config", "channel-review", "config.json"))).toBe(false);
	});

	test("channel-review setup writes no config or template when the legacy channel-review config cannot be copied", async () => {
		unreadable("channel-review/config.json");

		const result = await runCli(["bun", skillsEntry, "channel-review", "setup"], installEnv(home));

		expect(result.code).not.toBe(0);
		expect(existsSync(join(home, "config", "channel-review", "config.example.json"))).toBe(false);
		expect(existsSync(join(home, "config", "channel-review", "config.json"))).toBe(false);
	});
});
