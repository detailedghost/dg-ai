import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile } from "../../src/services/env-file";

const dirs: string[] = [];

function envFile(text: string, mode: number): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-env-"));
	dirs.push(dir);
	const path = join(dir, ".env");
	writeFileSync(path, text, { mode });
	chmodSync(path, mode);
	return path;
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("parseEnvFile", () => {
	it("reads pairs, skips blanks and # lines, and unquotes values", () => {
		expect(
			parseEnvFile(
				"# secrets\n\nTOKEN=abc=def\nNAME=\"two words\"\nRAW='x'\r\n",
			),
		).toEqual({ TOKEN: "abc=def", NAME: "two words", RAW: "x" });
	});

	it.each(["no-equals", "=novalue", "1BAD=x", "A B=x"])(
		"rejects the malformed line %j",
		(line) => {
			expect(() => parseEnvFile(line)).toThrow("KEY=VALUE");
		},
	);
});

describe("loadEnvFile", () => {
	it("loads a file only the owner can read", () => {
		expect(loadEnvFile(envFile("A=1", 0o600))).toEqual({ A: "1" });
	});

	it("refuses a file other users can read", () => {
		const path = envFile("A=1", 0o644);
		expect(() => loadEnvFile(path)).toThrow("chmod 600");
	});

	it("does not echo file contents in its error", () => {
		expect(() => loadEnvFile(envFile("SECRET_TOKEN_VALUE", 0o600))).toThrow(
			/^(?!.*SECRET_TOKEN_VALUE)/,
		);
	});
});
