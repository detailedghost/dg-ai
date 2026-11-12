import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DgCliError } from "../src/errors";
import { writeCredentialGrantToken } from "../src/node/credential-grants";
import { writeDgConfig } from "../src/node/dg-config";
import { resolveDgPaths } from "../src/node/dg-paths";

const posix = describe.skipIf(process.platform === "win32");

let home: string;

function put(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-write-guard-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

posix("common writers refuse an unmoved legacy entry", () => {
	test("writeDgConfig throws and creates no config.json while the legacy config.json holds data", () => {
		const env = { DG_HOME: home };
		const paths = resolveDgPaths({ env });
		put(join(paths.legacyHome, "config.json"), '{"hooks":{}}');

		expect(() => writeDgConfig({ hooks: { a: 1 } }, env)).toThrow(DgCliError);
		expect(existsSync(paths.configPath)).toBe(false);
	});

	test("writeCredentialGrantToken throws and creates no grants folder while the legacy grants folder holds data", () => {
		const paths = resolveDgPaths({ env: {}, homeDir: home });
		put(join(paths.legacyHome, "grants", "ci.token"), "old");

		expect(() => writeCredentialGrantToken(paths, "ci", "new")).toThrow(DgCliError);
		expect(existsSync(paths.grantsDir)).toBe(false);
	});
});
