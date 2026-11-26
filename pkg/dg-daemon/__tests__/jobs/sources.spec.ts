import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import {
	isTreeId,
	findMarkRecord,
	findRecordByJob,
	type GitSourceRecord,
	readNamedSources,
	readSourceRecords,
	updateMarks,
	writeSource,
	type RecordRegistry,
} from "../../src/jobs/sources";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const SHA = "a".repeat(40);
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

const pathsOf = () => {
	const home = freshDgHome();
	homes.push(home);
	return resolveDgPaths({ env: { DG_HOME: home } });
};

const record = (extra: Partial<GitSourceRecord> = {}): GitSourceRecord => ({
	kind: "git",
	url: "file:///tmp/bot",
	ref: null,
	sha: SHA,
	jobs: ["a"],
	declarationHash: "f".repeat(64),
	credentials: {},
	...extra,
});

function seed(paths: ReturnType<typeof pathsOf>, text: string): void {
	mkdirSync(dirname(paths.jobSourcesPath), { recursive: true });
	writeFileSync(paths.jobSourcesPath, text);
}

describe("readNamedSources", () => {
	it("returns an empty registry when the file is absent", () => {
		expect(readNamedSources(pathsOf())).toEqual({});
	});

	it("reads a valid registry", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ bot: record({ ref: "v1" }) }));
		expect((readNamedSources(paths).bot as GitSourceRecord).ref).toBe("v1");
	});

	it.each([
		["invalid JSON", "{"],
		["an array", "[]"],
		["null", "null"],
		["a string", '"x"'],
	])("throws an error that names the file for %s", (_label, text) => {
		const paths = pathsOf();
		seed(paths, text);
		expect(() => readNamedSources(paths)).toThrow(paths.jobSourcesPath);
	});

	it.each([
		["a short sha", { sha: "abc123" }],
		["an upper-case sha", { sha: "A".repeat(40) }],
		["jobs that is not an array", { jobs: "a" }],
		["a job name that is not valid", { jobs: ["A B"] }],
		["a ref that is a number", { ref: 3 }],
		["a url that is not a string", { url: 1 }],
		["an unknown kind", { kind: "weird" }],
		["a url that starts with a dash", { url: "--upload-pack=x" }],
		["a ref that starts with a dash", { ref: "--upload-pack=x" }],
		["credentials that is an array", { credentials: [] }],
		["a declarationHash that is not a string", { declarationHash: 1 }],
	])("throws an error that names the file and the source for %s", (_label, bad) => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ bot: { ...record(), ...bad } }));
		let message = "";
		try {
			readNamedSources(paths);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain(paths.jobSourcesPath);
		expect(message).toContain('"bot"');
	});

	it("throws for a source name that is not a valid name", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ "../x": record() }));
		expect(() => readNamedSources(paths)).toThrow("../x");
	});

	it("throws for a source record that is not an object", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ bot: 1 }));
		expect(() => readNamedSources(paths)).toThrow('"bot"');
	});
});

describe("writeSource", () => {
	it("writes the file with mode 0600 and keeps the other sources", () => {
		const paths = pathsOf();
		writeSource(paths, "a", record());
		writeSource(paths, "b", record({ jobs: ["b"] }));

		expect(Object.keys(readNamedSources(paths))).toEqual(["a", "b"]);
		expect(statSync(paths.jobSourcesPath).mode & 0o777).toBe(0o600);
	});

	it("removes one record when given undefined and keeps the rest", () => {
		const paths = pathsOf();
		writeSource(paths, "a", record());
		writeSource(paths, "b", record({ jobs: ["b"] }));

		writeSource(paths, "a", undefined);

		expect(Object.keys(readNamedSources(paths))).toEqual(["b"]);
	});

	it("refuses to overwrite a file that is not a JSON object", () => {
		const paths = pathsOf();
		seed(paths, "[]");
		expect(() => writeSource(paths, "a", record())).toThrow(
			paths.jobSourcesPath,
		);
		expect(readFileSync(paths.jobSourcesPath, "utf8")).toBe("[]");
	});
});

describe("findRecordByJob", () => {
	it("gives the source and the record that list the job", () => {
		const registry = { a: record({ jobs: ["x"] }), b: record({ jobs: ["y", "z"] }) };
		expect(findRecordByJob(registry, "z")).toEqual({
			source: "b",
			record: registry.b,
		});
	});

	it("gives undefined for a job that no record lists", () => {
		expect(findRecordByJob({ a: record() }, "nope")).toBeUndefined();
	});
});

describe("readNamedSources marks and command records", () => {
	it("accepts a command record with both marks", () => {
		const paths = pathsOf();
		seed(
			paths,
			JSON.stringify({ x: { kind: "command", prefixAccepted: true, setupDone: ["x"] } }),
		);
		expect(readSourceRecords(paths).x).toEqual({
			kind: "command",
			prefixAccepted: true,
			setupDone: ["x"],
		});
	});

	it("leaves a command record out of readNamedSources and keeps it when another record is written", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ x: { kind: "command", prefixAccepted: true } }));
		writeSource(paths, "bot", record());
		expect(Object.keys(readNamedSources(paths))).toEqual(["bot"]);
		expect(readSourceRecords(paths).x).toEqual({ kind: "command", prefixAccepted: true });
	});

	it("accepts a git record with no mark and with both marks", () => {
		const paths = pathsOf();
		seed(
			paths,
			JSON.stringify({
				a: record(),
				b: record({ jobs: ["b"], prefixAccepted: false, setupDone: ["b"] }),
			}),
		);
		expect(Object.keys(readSourceRecords(paths))).toEqual(["a", "b"]);
	});

	it.each([
		["a git record with an unknown key", { bot: { ...record(), extra: 1 } }],
		["a command record with an unknown key", { bot: { kind: "command", url: "x" } }],
		["a prefixAccepted that is not a boolean", { bot: { ...record(), prefixAccepted: "yes" } }],
		["a setupDone that is not an array", { bot: { ...record(), setupDone: "a" } }],
		["a setupDone with a bad job name", { bot: { ...record(), setupDone: ["A B"] } }],
		["a command record with a bad setupDone", { bot: { kind: "command", setupDone: [1] } }],
	])("throws for %s", (_label, registry) => {
		const paths = pathsOf();
		seed(paths, JSON.stringify(registry));
		expect(() => readSourceRecords(paths)).toThrow('"bot"');
	});
});

describe("findMarkRecord", () => {
	it("finds a git record by its job and a command record by its key", () => {
		const registry = {
			a: record({ jobs: ["x"] }),
			y: { kind: "command" as const },
		};
		expect(findMarkRecord(registry, "x")?.source).toBe("a");
		expect(findMarkRecord(registry, "y")?.source).toBe("y");
		expect(findMarkRecord(registry, "z")).toBeUndefined();
	});

	it("leaves a command record out of findRecordByJob", () => {
		expect(findRecordByJob({ y: { kind: "command" } }, "y")).toBeUndefined();
	});
});

describe("updateMarks", () => {
	it("makes a command record for a job that has none", () => {
		const paths = pathsOf();
		updateMarks(paths, "x", { prefixAccepted: true, setupDone: "x" });
		expect(readSourceRecords(paths).x).toEqual({
			kind: "command",
			prefixAccepted: true,
			setupDone: ["x"],
		});
	});

	it("writes the marks into the record of a source and keeps the other keys", () => {
		const paths = pathsOf();
		writeSource(paths, "bot", record({ jobs: ["a", "b"] }));
		updateMarks(paths, "a", { setupDone: "a" });
		updateMarks(paths, "b", { prefixAccepted: true, setupDone: "b" });
		updateMarks(paths, "a", { setupDone: "a" });
		const stored = readSourceRecords(paths).bot as GitSourceRecord;
		expect(stored.setupDone).toEqual(["a", "b"]);
		expect(stored.prefixAccepted).toBe(true);
		expect(stored.sha).toBe(SHA);
	});
});

describe("path records", () => {
	const folder = (extra: Record<string, unknown> = {}) => ({
		kind: "path" as const,
		path: "/srv/tools",
		jobs: ["a"],
		declarationHash: "f".repeat(64),
		credentials: {},
		...extra,
	});

	it("accepts a folder record and a file record and keeps both in readNamedSources", () => {
		const paths = pathsOf();
		const file = { kind: "path" as const, path: "/srv/poll.ts", jobs: ["poll"], credentials: {} };
		seed(paths, JSON.stringify({ tools: folder(), poll: file }));

		expect(readNamedSources(paths).tools).toEqual(folder());
		expect(readSourceRecords(paths).poll).toEqual(file);
	});

	it("keeps the env detail of a credential on a git record and a path record", () => {
		const paths = pathsOf();
		const credentials = { "api-key": { prompt: "Key", env: "API_KEY" } };
		seed(
			paths,
			JSON.stringify({ bot: record({ credentials }), tools: folder({ credentials }) }),
		);

		expect(readSourceRecords(paths).bot).toMatchObject({ credentials });
		expect(readSourceRecords(paths).tools).toMatchObject({ credentials });
	});

	it("accepts the two marks on a path record", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ tools: folder({ prefixAccepted: true, setupDone: ["a"] }) }));
		expect(readSourceRecords(paths).tools).toMatchObject({ prefixAccepted: true, setupDone: ["a"] });
	});

	it.each([
		["a relative path", { path: "tools" }],
		["a path that is not a string", { path: 1 }],
		["jobs that is not an array", { jobs: "a" }],
		["a job name that is not valid", { jobs: ["A B"] }],
		["credentials that is an array", { credentials: [] }],
		["a declarationHash that is not 64 hexadecimal characters", { declarationHash: "abc" }],
		["a url key", { url: "x" }],
		["a sha key", { sha: "a".repeat(40) }],
	])("throws an error that names the file and the source for %s", (_label, bad) => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ tools: folder(bad) }));
		let message = "";
		try {
			readSourceRecords(paths);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain(paths.jobSourcesPath);
		expect(message).toContain('"tools"');
	});

	it("finds a path record by its job and gives its marks to findMarkRecord", () => {
		const registry: RecordRegistry = { tools: { ...folder(), setupDone: ["a"] } };
		expect(findRecordByJob(registry, "a")?.source).toBe("tools");
		expect(findMarkRecord(registry, "a")?.record.setupDone).toEqual(["a"]);
	});

	it("keeps a path record when the marks change", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ tools: folder() }));

		updateMarks(paths, "a", { prefixAccepted: true });

		expect(readSourceRecords(paths).tools).toEqual(folder({ prefixAccepted: true }));
	});
});

describe("isTreeId", () => {
	it("accepts a sha1 and a sha256 tree id", () => {
		expect(isTreeId("a".repeat(40))).toBe(true);
		expect(isTreeId("b".repeat(64))).toBe(true);
	});

	it("rejects other lengths, uppercase and non-hex text", () => {
		for (const text of ["", "a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), `${"a".repeat(40)}\n`]) {
			expect(isTreeId(text)).toBe(false);
		}
	});
});
