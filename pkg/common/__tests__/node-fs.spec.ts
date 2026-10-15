import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, rotateLogIfLarge } from "../src/node/fs";

describe("ensurePrivateDir", () => {
	it("repairs permissions on an existing directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-private-dir-"));
		try {
			chmodSync(directory, 0o777);

			ensurePrivateDir(directory);

			expect(statSync(directory).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});

describe("rotateLogIfLarge", () => {
	const withLog = (body: (log: string) => void) => {
		const directory = mkdtempSync(join(tmpdir(), "dg-rotate-"));
		try {
			body(join(directory, "daemon.log"));
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	};

	it("copies a log over the limit to .1 and empties it", () =>
		withLog((log) => {
			writeFileSync(log, "x".repeat(20));
			rotateLogIfLarge(log, 10);
			expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(20));
			expect(statSync(log).size).toBe(0);
		}));

	it("leaves a log under the limit and a missing log alone", () =>
		withLog((log) => {
			rotateLogIfLarge(log, 10);
			expect(existsSync(`${log}.1`)).toBe(false);
			writeFileSync(log, "short");
			rotateLogIfLarge(log, 10);
			expect(existsSync(`${log}.1`)).toBe(false);
			expect(readFileSync(log, "utf8")).toBe("short");
		}));
});
