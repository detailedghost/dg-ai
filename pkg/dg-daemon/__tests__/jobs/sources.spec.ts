import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import {
	findRecordByJob,
	type GitSourceRecord,
	readSources,
	writeSource,
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

describe("readSources", () => {
	it("returns an empty registry when the file is absent", () => {
		expect(readSources(pathsOf())).toEqual({});
	});

	it("reads a valid registry", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ bot: record({ ref: "v1" }) }));
		expect(readSources(paths).bot.ref).toBe("v1");
	});

	it.each([
		["invalid JSON", "{"],
		["an array", "[]"],
		["null", "null"],
		["a string", '"x"'],
	])("throws an error that names the file for %s", (_label, text) => {
		const paths = pathsOf();
		seed(paths, text);
		expect(() => readSources(paths)).toThrow(paths.jobSourcesPath);
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
			readSources(paths);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain(paths.jobSourcesPath);
		expect(message).toContain('"bot"');
	});

	it("throws for a source name that is not a valid name", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ "../x": record() }));
		expect(() => readSources(paths)).toThrow("../x");
	});

	it("throws for a source record that is not an object", () => {
		const paths = pathsOf();
		seed(paths, JSON.stringify({ bot: 1 }));
		expect(() => readSources(paths)).toThrow('"bot"');
	});
});

describe("writeSource", () => {
	it("writes the file with mode 0600 and keeps the other sources", () => {
		const paths = pathsOf();
		writeSource(paths, "a", record());
		writeSource(paths, "b", record({ jobs: ["b"] }));

		expect(Object.keys(readSources(paths))).toEqual(["a", "b"]);
		expect(statSync(paths.jobSourcesPath).mode & 0o777).toBe(0o600);
	});

	it("removes one record when given undefined and keeps the rest", () => {
		const paths = pathsOf();
		writeSource(paths, "a", record());
		writeSource(paths, "b", record({ jobs: ["b"] }));

		writeSource(paths, "a", undefined);

		expect(Object.keys(readSources(paths))).toEqual(["b"]);
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
