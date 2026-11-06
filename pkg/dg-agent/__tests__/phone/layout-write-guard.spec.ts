import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { ensureLayout, type LayoutResult } from "@dg/common/node/layout";
import { Command } from "commander";
import { phoneRun, type RunDeps } from "../../src/phone/commands";
import * as migrate from "../../src/phone/migrate";
import { type PhoneApi, registerPhoneGroup } from "../../src/phone/register";

const posix = describe.skipIf(process.platform === "win32");

let dir: string;
let paths: DgPaths;

function put(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dg-agent-phone-write-guard-"));
	paths = resolveDgPaths({ platform: "linux", homeDir: join(dir, "home"), env: {} });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

posix("phone listen, which skips ensureLayout", () => {
	it("creates no phone folder while the legacy phone folder holds data", async () => {
		put(join(paths.legacyHome, "phone", "phone.db"), "rows");

		const attempt = phoneRun({}, { paths, pid: process.pid } as unknown as RunDeps);

		await expect(attempt).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(paths.phoneRoot)).toBe(false);
	});
});

async function blockPhone(): Promise<void> {
	const from = join(paths.legacyHome, "phone");
	await ensureLayout(paths, {
		log: () => {},
		readdir: () => ["phone"],
		load: async () =>
			({
				snapshot: () => ({}),
				planLayout: () => ({}),
				mutates: () => false,
				applyLayout: () =>
					({
						phone: { kind: "blocked", reason: "live-writer", from, to: paths.phoneRoot, fix: `dg: kept ${from}; stop it` },
					}) as unknown as LayoutResult,
			}) as never,
	});
}

posix("phone close and off while the legacy phone folder is unmoved", () => {
	for (const verb of ["close", "off"]) {
		it(`phone ${verb} never converts phone-friend lines into the per-OS phone folder`, async () => {
			const convert = spyOn(migrate, "migrateIfNeeded").mockImplementation(() => ({ migrated: false }));
			await blockPhone();
			const api = {
				openCloseDeps: () => ({ paths, write: () => {} }),
				phoneClose: async () => {},
				ignoreHangup: () => {},
			} as unknown as PhoneApi;
			const program = new Command().exitOverride();
			registerPhoneGroup(program, async () => api);

			await program.parseAsync(["phone", verb], { from: "user" });

			expect(convert).not.toHaveBeenCalled();
			convert.mockRestore();
		});
	}
});
