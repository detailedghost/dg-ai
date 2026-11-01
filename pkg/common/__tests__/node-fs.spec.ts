import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensurePrivateDir,
	rotateLogIfLarge,
	writeFileAtomic,
} from "../src/node/fs";

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

describe("writeFileAtomic", () => {
	const withDir = (body: (dir: string) => void) => {
		const directory = mkdtempSync(join(tmpdir(), "dg-atomic-"));
		try {
			body(directory);
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	};

	it.skipIf(process.platform === "win32")(
		"applies the requested mode despite a restrictive umask",
		() =>
			withDir((dir) => {
				const previous = process.umask(0o077);
				try {
					const target = join(dir, "out.txt");
					writeFileAtomic(target, "x", 0o644);
					expect(statSync(target).mode & 0o777).toBe(0o644);
				} finally {
					process.umask(previous);
				}
			}),
	);

	it("leaves no temp file when the injected rename fails", () =>
		withDir((dir) => {
			const target = join(dir, "out.txt");
			writeFileSync(target, "old");
			expect(() =>
				writeFileAtomic(target, "new", 0o600, () => {
					throw new Error("rename failed");
				}),
			).toThrow("rename failed");
			expect(readdirSync(dir)).toEqual(["out.txt"]);
			expect(readFileSync(target, "utf8")).toBe("old");
		}));

	it("leaves no temp file when the target path cannot be replaced", () =>
		withDir((dir) => {
			const target = join(dir, "occupied");
			mkdirSync(join(target, "child"), { recursive: true });
			expect(() => writeFileAtomic(target, "x")).toThrow();
			expect(readdirSync(dir)).toEqual(["occupied"]);
		}));

	it.skipIf(process.platform === "win32")(
		"writes the requested mode to a new file and over an existing one",
		() =>
			withDir((dir) => {
				const target = join(dir, "out.txt");
				writeFileAtomic(target, "a", 0o600);
				expect(statSync(target).mode & 0o777).toBe(0o600);
				writeFileAtomic(target, "b", 0o755);
				expect(statSync(target).mode & 0o777).toBe(0o755);
				expect(readFileSync(target, "utf8")).toBe("b");
			}),
	);
});
