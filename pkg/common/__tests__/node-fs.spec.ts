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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensurePrivateDir,
	insideRoot,
	removeInside,
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

describe("insideRoot", () => {
	it("accepts only paths strictly inside the root", () => {
		expect(insideRoot("/a/root", "/a/root/x")).toBe(true);
		expect(insideRoot("/a/root", "/a/root")).toBe(false);
		expect(insideRoot("/a/root", "/a/root/")).toBe(false);
		expect(insideRoot("/a/root", "/a/root/../other")).toBe(false);
		expect(insideRoot("/a/root", "/a/rootless/x")).toBe(false);
	});
});

describe("removeInside", () => {
	const withRoot = (body: (root: string) => void) => {
		const root = mkdtempSync(join(tmpdir(), "dg-remove-inside-"));
		try {
			body(root);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	};
	const refusal = (root: string, dir: string) =>
		`refused to delete ${dir}: it is not inside ${root}`;

	it("throws the refusal text and deletes nothing for the root itself", () => {
		withRoot((root) => {
			mkdirSync(join(root, "keep"));
			expect(() => removeInside(root, root)).toThrow(refusal(root, root));
			expect(existsSync(join(root, "keep"))).toBe(true);
		});
	});

	it("throws and deletes nothing for a path that climbs out of the root", () => {
		withRoot((parent) => {
			const root = join(parent, "root");
			const other = join(parent, "other");
			mkdirSync(root);
			mkdirSync(other);
			const dir = join(root, "..", "other");
			expect(() => removeInside(root, dir)).toThrow(refusal(root, dir));
			expect(existsSync(other)).toBe(true);
		});
	});

	it("throws and deletes nothing for a sibling that shares the root name prefix", () => {
		withRoot((parent) => {
			const root = join(parent, "root");
			const sibling = join(parent, "rootless", "x");
			mkdirSync(root);
			mkdirSync(sibling, { recursive: true });
			expect(() => removeInside(root, sibling)).toThrow(refusal(root, sibling));
			expect(existsSync(sibling)).toBe(true);
		});
	});

	it("throws an Error instance", () => {
		withRoot((root) => {
			expect(() => removeInside(root, root)).toThrow(Error);
		});
	});

	it("deletes a directory inside the root and keeps its siblings", () => {
		withRoot((root) => {
			const target = join(root, "a");
			mkdirSync(join(target, "deep"), { recursive: true });
			writeFileSync(join(target, "deep", "f.txt"), "x");
			mkdirSync(join(root, "b"));
			removeInside(root, target);
			expect(existsSync(target)).toBe(false);
			expect(existsSync(join(root, "b"))).toBe(true);
			expect(existsSync(root)).toBe(true);
		});
	});

	it("does not throw for a missing directory inside the root", () => {
		withRoot((root) => {
			expect(() => removeInside(root, join(root, "absent"))).not.toThrow();
		});
	});

	it.skipIf(process.platform === "win32")(
		"throws and deletes nothing when a link inside the root leads outside it",
		() => {
			withRoot((parent) => {
				const root = join(parent, "root");
				const outside = join(parent, "outside");
				mkdirSync(root);
				mkdirSync(join(outside, "sub"), { recursive: true });
				writeFileSync(join(outside, "sub", "f.txt"), "x");
				symlinkSync(outside, join(root, "x"));
				const dir = join(root, "x", "sub");
				expect(() => removeInside(root, dir)).toThrow(refusal(root, dir));
				expect(existsSync(join(outside, "sub", "f.txt"))).toBe(true);
			});
		},
	);

	describe.skipIf(process.platform === "win32")(
		"links are removed, never followed",
		() => {
			const withLinkedRoot = (
				body: (root: string, outside: string) => void,
			) => {
				withRoot((parent) => {
					const root = join(parent, "root");
					const outside = join(parent, "outside");
					mkdirSync(root);
					mkdirSync(join(outside, "sub"), { recursive: true });
					mkdirSync(join(outside, "victim", "sub"), { recursive: true });
					writeFileSync(join(outside, "keep.txt"), "x");
					writeFileSync(join(outside, "victim", "keep.txt"), "x");
					writeFileSync(join(outside, "victim", "sub", "keep.txt"), "x");
					symlinkSync(join(outside, "sub"), join(root, "x"));
					body(root, outside);
				});
			};

			it("removes a link that is the target and keeps what it points to", () => {
				withLinkedRoot((root, outside) => {
					symlinkSync(outside, join(root, "link"));
					removeInside(root, join(root, "link"));
					expect(existsSync(join(root, "link"))).toBe(false);
					expect(existsSync(join(outside, "keep.txt"))).toBe(true);
				});
			});

			it("removes a tree that holds a link and keeps what the link points to", () => {
				withLinkedRoot((root, outside) => {
					mkdirSync(join(root, "tree"));
					symlinkSync(outside, join(root, "tree", "inner"));
					removeInside(root, join(root, "tree"));
					expect(existsSync(join(root, "tree"))).toBe(false);
					expect(existsSync(join(outside, "keep.txt"))).toBe(true);
				});
			});

			it("resolves a parent step after a link lexically and stays inside the root", () => {
				withLinkedRoot((root, outside) => {
					mkdirSync(join(root, "victim"));
					writeFileSync(join(root, "victim", "f.txt"), "x");
					removeInside(root, `${join(root, "x")}/../victim`);
					expect(existsSync(join(root, "victim"))).toBe(false);
					expect(existsSync(join(outside, "victim", "keep.txt"))).toBe(true);
					expect(existsSync(join(outside, "victim", "sub", "keep.txt"))).toBe(
						true,
					);
				});
			});

			it("does nothing for a parent step whose lexical target is missing", () => {
				withLinkedRoot((root, outside) => {
					expect(() =>
						removeInside(root, `${join(root, "x")}/../victim/sub`),
					).not.toThrow();
					expect(existsSync(join(outside, "victim", "sub", "keep.txt"))).toBe(
						true,
					);
				});
			});
		},
	);
});
