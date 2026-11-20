import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrivateOpenFile, loadEnvFile, parseEnvFile } from "../../src/services/env-file";

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

describe("assertPrivateOpenFile", () => {
	const check = (path: string, noun = "--setup file") => {
		const fd = openSync(path, "r");
		try {
			assertPrivateOpenFile(fd, path, noun);
		} finally {
			closeSync(fd);
		}
	};

	it("passes a regular file that only the owner can use", () => {
		expect(() => check(envFile("A=1", 0o600))).not.toThrow();
	});

	it("names the noun and the path for a file that other users can read", () => {
		const path = envFile("A=1", 0o644);
		expect(() => check(path)).toThrow(
			`--setup file ${path} is readable by other users; run chmod 600 on it`,
		);
	});

	it("checks the target of a link, not the link", () => {
		const path = envFile("A=1", 0o644);
		const link = `${path}.link`;
		symlinkSync(path, link);
		expect(() => check(link)).toThrow("readable by other users");
	});

	it("refuses a directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-env-"));
		dirs.push(dir);
		expect(() => check(dir)).toThrow(`--setup file is not a regular file: ${dir}`);
	});
});
