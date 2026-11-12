import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	readdirSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	copyTree,
	moveVerified,
	removeSource,
	setAsideUnusedRoot,
	treeContained,
	treeMatches,
} from "@dg/common/node";
import { folderUnused, sqliteUnused } from "../src/node/sqlite-unused";

let dir: string;
let from: string;
let to: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-tree-copy-"));
	from = join(dir, "from");
	to = join(dir, "to");
	mkdirSync(join(from, "sub"), { recursive: true, mode: 0o700 });
	writeFileSync(join(from, "sub", "run"), "#!/bin/sh\n", { mode: 0o755 });
	symlinkSync("sub", join(from, "relative"));
	symlinkSync(join(from, "sub"), join(from, "absolute"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("copyTree", () => {
	it("keeps modes and relative links and rebases an absolute link into the copy", () => {
		copyTree(from, to);

		expect(statSync(join(to, "sub")).mode & 0o777).toBe(0o700);
		expect(statSync(join(to, "sub", "run")).mode & 0o777).toBe(0o755);
		expect(readlinkSync(join(to, "relative"))).toBe("sub");
		expect(readlinkSync(join(to, "absolute"))).toBe(join(to, "sub"));
		expect(treeMatches(from, to)).toBe(true);
	});

	it("reports a mismatch when a copied file changes size", () => {
		copyTree(from, to);
		writeFileSync(join(to, "sub", "run"), "longer contents");

		expect(treeMatches(from, to)).toBe(false);
	});

	it("copies a self-referencing link as a link", () => {
		symlinkSync("loop", join(from, "loop"));

		copyTree(from, to);

		expect(readlinkSync(join(to, "loop"))).toBe("loop");
		expect(treeMatches(from, to)).toBe(true);
	});

	it("matches a copied link written as an absolute path to the same target", () => {
		copyTree(from, to);
		rmSync(join(to, "relative"));
		symlinkSync(join(to, "sub"), join(to, "relative"));

		expect(treeMatches(from, to)).toBe(true);
	});

	it("counts a copy that gained files and moved a link as still holding every source file", () => {
		copyTree(from, to);
		writeFileSync(join(to, "sub", "new"), "added later");
		rmSync(join(to, "relative"));
		symlinkSync("elsewhere", join(to, "relative"));

		expect(treeMatches(from, to)).toBe(false);
		expect(treeContained(from, to)).toBe(true);
	});

	it("does not count a copy that lost a source file or changed its size", () => {
		copyTree(from, to);
		writeFileSync(join(to, "sub", "run"), "#!/bin/sh\necho changed\n");

		expect(treeContained(from, to)).toBe(false);
		rmSync(join(to, "sub", "run"));
		expect(treeContained(from, to)).toBe(false);
	});

	it("reports a mismatch when a source file changes to other bytes of the same size", () => {
		copyTree(from, to);
		writeFileSync(join(from, "sub", "run"), "#!/bin/zz\n");

		expect(treeMatches(from, to)).toBe(false);
		expect(treeContained(from, to)).toBe(false);
	});

	it("copies the files inside a read-only folder and keeps its mode", () => {
		mkdirSync(join(from, "locked"));
		writeFileSync(join(from, "locked", "note"), "kept");
		chmodSync(join(from, "locked"), 0o555);
		try {
			copyTree(from, to);

			expect(readFileSync(join(to, "locked", "note"), "utf8")).toBe("kept");
			expect(statSync(join(to, "locked")).mode & 0o777).toBe(0o555);
			expect(treeMatches(from, to)).toBe(true);
		} finally {
			chmodSync(join(from, "locked"), 0o755);
			try {
				chmodSync(join(to, "locked"), 0o755);
			} catch {}
		}
	});

	it("compares empty files and files that end on and past a 1 MiB chunk", () => {
		const mib = 1 << 20;
		writeFileSync(join(from, "empty"), "");
		writeFileSync(join(from, "exact"), Buffer.alloc(mib, 1));
		writeFileSync(join(from, "partial"), Buffer.alloc(mib + 7, 2));
		copyTree(from, to);
		expect(treeMatches(from, to)).toBe(true);

		for (const name of ["exact", "partial"]) {
			const bytes = Buffer.alloc(name === "exact" ? mib : mib + 7, name === "exact" ? 1 : 2);
			bytes[bytes.length - 1] = 9;
			writeFileSync(join(to, name), bytes);
			expect([name, treeMatches(from, to)]).toEqual([name, false]);
			copyTree(join(from, name), join(dir, `fresh-${name}`));
			rmSync(join(to, name));
			copyTree(join(dir, `fresh-${name}`), join(to, name));
		}
		expect(treeMatches(from, to)).toBe(true);
	});
});

const busy = (): never => {
	throw Object.assign(new Error("in use"), { code: "EBUSY" });
};

function sqliteFile(file: string, rows: number, wal = false): void {
	const db = new Database(file);
	if (wal) db.run("PRAGMA journal_mode = WAL");
	db.run("CREATE TABLE keys (id INTEGER PRIMARY KEY, name TEXT)");
	for (let row = 0; row < rows; row++) db.run("INSERT INTO keys (name) VALUES (?)", [`k${row}`]);
	db.close();
}

function folderBytes(root: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(root).map((name) => {
			const stat = statSync(join(root, name));
			return [name, `${stat.size}:${stat.mtimeMs}:${readFileSync(join(root, name)).toString("base64")}`];
		}),
	);
}

describe("moveVerified", () => {
	it("copies the tree, removes the source and returns moved", async () => {
		const result = await moveVerified(from, to, { log: () => {} });

		expect(result).toBe("moved");
		expect(existsSync(from)).toBe(false);
		expect(readFileSync(join(to, "sub", "run"), "utf8")).toBe("#!/bin/sh\n");
	});

	it("keeps both sides and returns kept when the target already exists", async () => {
		mkdirSync(to);

		expect(await moveVerified(from, to, { log: () => {} })).toBe("kept");
		expect(existsSync(join(from, "sub", "run"))).toBe(true);
	});

	it("fails the move, removes the copy and keeps the source when verify returns a problem", async () => {
		const lines: string[] = [];
		const seen: string[] = [];

		const result = await moveVerified(from, to, {
			log: (line) => lines.push(line),
			verify: (copy) => {
				seen.push(copy);
				return ["row count differs"];
			},
		});

		expect(result).toBe("failed");
		expect(seen).toEqual([join(`${to}.dg-partial`, "to")]);
		expect(existsSync(to)).toBe(false);
		expect(existsSync(`${to}.dg-partial`)).toBe(false);
		expect(existsSync(join(from, "sub", "run"))).toBe(true);
		expect(lines.join("\n")).toContain("row count differs");
	});

	it("creates no target until the copy is checked", async () => {
		const seenTarget: boolean[] = [];

		const result = await moveVerified(from, to, {
			log: () => {},
			afterCopy: () => seenTarget.push(existsSync(to)),
			verify: () => {
				seenTarget.push(existsSync(to));
				return [];
			},
		});

		expect(result).toBe("moved");
		expect(seenTarget).toEqual([false, false]);
		expect(readlinkSync(join(to, "absolute"))).toBe(join(to, "sub"));
		expect(readlinkSync(join(to, "relative"))).toBe("sub");
		expect(existsSync(`${to}.dg-partial`)).toBe(false);
	});

	it("keeps the source and leaves no copy when the target appears during the copy", async () => {
		const result = await moveVerified(from, to, { log: () => {}, verify: () => (mkdirSync(to), []) });

		expect(result).toBe("failed");
		expect(readdirSync(to)).toEqual([]);
		expect(existsSync(join(from, "sub", "run"))).toBe(true);
		expect(existsSync(`${to}.dg-partial`)).toBe(false);
	});

	it("moves when verify returns no problem", async () => {
		expect(await moveVerified(from, to, { log: () => {}, verify: () => [] })).toBe("moved");
	});

	it("returns failed and removes the copy when the copy does not match the source", async () => {
		const result = await moveVerified(from, to, {
			log: () => {},
			afterCopy: (_from, copy) => writeFileSync(join(copy, "sub", "run"), "changed after the copy"),
		});

		expect(result).toBe("failed");
		expect(existsSync(to)).toBe(false);
		expect(existsSync(from)).toBe(true);
	});

	it("returns scheduled and keeps both copies when the source is held open", async () => {
		const lines: string[] = [];

		const result = await moveVerified(from, to, { log: (line) => lines.push(line), rename: busy });

		expect(result).toBe("scheduled");
		expect(existsSync(join(from, "sub", "run"))).toBe(true);
		expect(existsSync(join(to, "sub", "run"))).toBe(true);
	});
});

describe("moveVerified with a list of files", () => {
	const seed = (): string[] => {
		const files = ["memory.db", "memory.db-wal"].map((name) => join(from, name));
		for (const file of files) writeFileSync(file, `bytes of ${file}`);
		return files;
	};

	it("returns scheduled with the first file gone when only the -wal file is held", async () => {
		const files = seed();

		const result = await moveVerified(files, to, {
			log: () => {},
			rename: (source, target) => (source.endsWith("-wal") ? busy() : renameSync(source, target)),
		});

		expect(result).toBe("scheduled");
		expect(existsSync(files[0] as string)).toBe(false);
		expect(existsSync(files[1] as string)).toBe(true);
		expect(readdirSync(to).sort()).toEqual(["memory.db", "memory.db-wal"]);
	});

	it("removes the files it placed and keeps every source when a later file cannot be placed", async () => {
		const files = seed();

		const result = await moveVerified(files, to, {
			log: () => {},
			place: (stage, target) => (target.endsWith("memory.db") ? busy() : renameSync(stage, target)),
		});

		expect(result).toBe("failed");
		expect(readdirSync(to)).toEqual([]);
		expect(files.every((file) => existsSync(file))).toBe(true);
	});

	it("moves every file into the folder as one unit", async () => {
		const files = seed();

		const result = await moveVerified(files, to, { log: () => {} });

		expect(result).toBe("moved");
		expect(readdirSync(to).sort()).toEqual(["memory.db", "memory.db-wal"]);
		expect(files.some((file) => existsSync(file))).toBe(false);
	});

	it("removes every copy and keeps every source when one copy fails its check", async () => {
		const files = seed();

		const result = await moveVerified(files, to, {
			log: () => {},
			verify: (copy) => (copy.endsWith("-wal") ? ["wal differs"] : []),
		});

		expect(result).toBe("failed");
		expect(readdirSync(to)).toEqual([]);
		expect(files.every((file) => existsSync(file))).toBe(true);
	});

	it("keeps every source when one target file already exists", async () => {
		const files = seed();
		mkdirSync(to);
		writeFileSync(join(to, "memory.db-wal"), "other");

		expect(await moveVerified(files, to, { log: () => {} })).toBe("kept");
		expect(readdirSync(to)).toEqual(["memory.db-wal"]);
		expect(files.every((file) => existsSync(file))).toBe(true);
	});
});

describe("removeSource", () => {
	it("removes the source and returns true", () => {
		expect(removeSource(from, {})).toBe(true);
		expect(existsSync(from)).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("returns false and leaves the source when the rename fails", () => {
		expect(removeSource(from, { rename: busy })).toBe(false);
		expect(existsSync(join(from, "sub", "run"))).toBe(true);
	});
});

describe("setAsideUnusedRoot", () => {
	it("renames the root to <root>.empty-<ts> and leaves no folder at the old path", () => {
		const root = join(dir, "phone");
		mkdirSync(root);

		setAsideUnusedRoot(root, 1_700_000_000_000);

		expect(existsSync(root)).toBe(false);
		const aside = readdirSync(dir).filter((name) => name.startsWith("phone.empty-"));
		expect(aside).toHaveLength(1);
	});
});

describe("sqliteUnused", () => {
	it("is true for a db whose tables are all empty and false once a table has a row", () => {
		sqliteFile(join(dir, "empty.db"), 0);
		sqliteFile(join(dir, "used.db"), 1);

		expect(sqliteUnused(join(dir, "empty.db"))).toBe(true);
		expect(sqliteUnused(join(dir, "used.db"))).toBe(false);
	});

	it("leaves a WAL-mode db folder byte-identical, with no new -wal or -shm file", () => {
		const folder = join(dir, "db");
		mkdirSync(folder);
		const file = join(folder, "phone.db");
		sqliteFile(file, 0, true);
		const before = folderBytes(folder);

		expect(sqliteUnused(file)).toBe(true);

		expect(folderBytes(folder)).toEqual(before);
	});

	it("counts a db with a non-empty -wal file as used", () => {
		const file = join(dir, "phone.db");
		sqliteFile(file, 0);
		writeFileSync(`${file}-wal`, Buffer.alloc(64, 1));

		expect(sqliteUnused(file)).toBe(false);
	});
});

describe("sqliteUnused limits", () => {
	it("is false without opening a db file larger than 1 MiB", () => {
		const file = join(dir, "big.db");
		sqliteFile(file, 0);
		writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.alloc(1024 * 1024)]));

		expect(sqliteUnused(file)).toBe(false);
	});

	it("reads a table whose name holds a double quote", () => {
		const empty = join(dir, "quoted-empty.db");
		const used = join(dir, "quoted-used.db");
		for (const [file, rows] of [[empty, 0], [used, 1]] as const) {
			const db = new Database(file);
			db.run('CREATE TABLE "a""b" (id INTEGER)');
			if (rows > 0) db.run('INSERT INTO "a""b" (id) VALUES (1)');
			db.close();
		}

		expect(sqliteUnused(empty)).toBe(true);
		expect(sqliteUnused(used)).toBe(false);
	});

	it("stays out of the node index and tree-copy so importing them never loads bun:sqlite", () => {
		const src = join(import.meta.dir, "..", "src", "node");

		expect(readFileSync(join(src, "index.ts"), "utf8")).not.toContain("sqlite-unused");
		expect(readFileSync(join(src, "tree-copy.ts"), "utf8")).not.toContain("bun:sqlite");
	});
});

describe("sqliteUnused edge cases", () => {
	it("is false for a missing file and for a file that is not a database", () => {
		writeFileSync(join(dir, "junk.db"), "not a database at all, just text");

		expect(sqliteUnused(join(dir, "missing.db"))).toBe(false);
		expect(sqliteUnused(join(dir, "junk.db"))).toBe(false);
	});

	it("is true for a db with no tables", () => {
		const file = join(dir, "bare.db");
		const db = new Database(file);
		db.run("CREATE TABLE gone (id INTEGER)");
		db.run("DROP TABLE gone");
		db.close();

		expect(sqliteUnused(file)).toBe(true);
	});

	it("is false when only the second of two tables holds a row", () => {
		const file = join(dir, "two.db");
		const db = new Database(file);
		db.run("CREATE TABLE a (id INTEGER)");
		db.run("CREATE TABLE b (id INTEGER)");
		db.run("INSERT INTO b (id) VALUES (1)");
		db.close();

		expect(sqliteUnused(file)).toBe(false);
	});

	it("ignores the internal sqlite_sequence table of an autoincrement db", () => {
		const file = join(dir, "seq.db");
		const db = new Database(file);
		db.run("CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT)");
		db.run("INSERT INTO a DEFAULT VALUES");
		db.run("DELETE FROM a");
		db.close();

		expect(sqliteUnused(file)).toBe(true);
	});

	it("treats an empty -wal file as unused", () => {
		const file = join(dir, "phone.db");
		sqliteFile(file, 0);
		writeFileSync(`${file}-wal`, "");

		expect(sqliteUnused(file)).toBe(true);
	});
});

describe("folderUnused", () => {
	it("is true for an empty folder and false for a folder with another file", () => {
		const empty = join(dir, "empty");
		const other = join(dir, "other");
		mkdirSync(empty);
		mkdirSync(other);
		writeFileSync(join(other, "notes.txt"), "mine");

		expect(folderUnused(empty, "phone.db")).toBe(true);
		expect(folderUnused(other, "phone.db")).toBe(false);
	});

	it("is true when the folder holds only db files that are unused and false when one holds a row", () => {
		const root = join(dir, "phone");
		mkdirSync(root);
		sqliteFile(join(root, "phone.db"), 0);
		expect(folderUnused(root, "phone.db")).toBe(true);

		rmSync(join(root, "phone.db"));
		sqliteFile(join(root, "phone.db"), 2);
		expect(folderUnused(root, "phone.db")).toBe(false);
	});

	it("is false for a missing folder", () => {
		expect(folderUnused(join(dir, "missing"), "phone.db")).toBe(false);
	});

	it("is false for a folder with files when no db name is given", () => {
		const root = join(dir, "plain");
		mkdirSync(root);
		sqliteFile(join(root, "phone.db"), 0);

		expect(folderUnused(root)).toBe(false);
	});

	it("is false when a db-prefixed sidecar sits beside a db that holds a row", () => {
		const root = join(dir, "sidecar");
		mkdirSync(root);
		sqliteFile(join(root, "phone.db"), 1);
		writeFileSync(join(root, "phone.db-shm"), "");

		expect(folderUnused(root, "phone.db")).toBe(false);
	});

	it.each(["phone.db.backup", "phone.db.migrating", "phone.db.tmp", "phone.dbx"])("is false when %s sits beside an empty db", (name) => {
		const root = join(dir, `extra-${name}`);
		mkdirSync(root);
		sqliteFile(join(root, "phone.db"), 0);
		writeFileSync(join(root, name), "data");

		expect(folderUnused(root, "phone.db")).toBe(false);
	});

	it.each(["phone.db-wal", "phone.db-shm", "phone.db-journal"])("is true when the empty sidecar %s sits beside an empty db", (name) => {
		const root = join(dir, `side-${name}`);
		mkdirSync(root);
		sqliteFile(join(root, "phone.db"), 0);
		writeFileSync(join(root, name), "");

		expect(folderUnused(root, "phone.db")).toBe(true);
	});
});
