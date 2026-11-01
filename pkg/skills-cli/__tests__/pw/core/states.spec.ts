import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { UsageError } from "../../../src/pw/core/args";
import {
	formatSummary,
	importFile,
	importLegacyOnce,
	list,
	load,
	remove,
	StateNotFoundError,
	save,
	statePathFor,
	statesDir,
	validateName,
} from "../../../src/pw/core/states";
import { useTempEnv } from "../../../src/pw/test-support";

const stateRoot = useTempEnv("AI_STATE_DIR");
const cacheRoot = useTempEnv("XDG_CACHE_HOME");

const mode = (file: string): number => statSync(file).mode & 0o777;
const cookie = (domain: string) => ({
	name: "c",
	value: "v",
	domain,
	path: "/",
	expires: -1,
	httpOnly: false,
	secure: false,
	sameSite: "Lax" as const,
});

const legacyDir = (): string => path.join(cacheRoot.dir, "playwright-cli", "sessions");

function seedLegacy(files: Record<string, string>): void {
	mkdirSync(legacyDir(), { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(legacyDir(), name), text);
}

describe("name validation", () => {
	test.each(["../x", "a/b", ".hidden", "UPPER", "", "-lead", "a b", "x".repeat(65)])(
		"rejects %p with a usage error",
		(name) => {
			expect(() => validateName(name)).toThrow(UsageError);
			expect(() => validateName(name)).toThrow("state name must match ^[a-z0-9][a-z0-9._-]{0,63}$");
		},
	);

	test.each(["site", "a", "timesheet.v2", "x_y-z", "x".repeat(64)])("accepts %p", (name) => {
		expect(validateName(name)).toBe(name);
	});

	test("never builds a path outside the states directory", () => {
		expect(() => statePathFor("../escape")).toThrow(UsageError);
		expect(path.dirname(statePathFor("ok"))).toBe(statesDir());
	});
});

describe("save and load", () => {
	test("round-trips a state with directory mode 0700 and file mode 0600", () => {
		save("site", { cookies: [cookie("a.test")], origins: [] });
		expect(load("site")).toEqual({ cookies: [cookie("a.test")], origins: [] });
		expect(mode(statesDir())).toBe(0o700);
		expect(mode(statePathFor("site"))).toBe(0o600);
		expect(statePathFor("site")).toBe(path.join(stateRoot.dir, "pw", "states", "site.json"));
	});

	test("tightens an existing 0644 file to 0600", () => {
		save("site", { cookies: [], origins: [] });
		chmodSync(statePathFor("site"), 0o644);
		save("site", { cookies: [cookie("a.test")], origins: [] });
		expect(mode(statePathFor("site"))).toBe(0o600);
	});

	test("tightens an existing 0755 states directory to 0700", () => {
		mkdirSync(path.join(stateRoot.dir, "pw", "states"), {
			recursive: true,
			mode: 0o755,
		});
		expect(mode(statesDir())).toBe(0o700);
	});

	test("leaves no temporary file behind", () => {
		save("site", { cookies: [], origins: [] });
		expect(readdirSync(statesDir())).toEqual(["site.json"]);
	});

	test("reports an unknown name", () => {
		expect(() => load("nope")).toThrow(StateNotFoundError);
		expect(() => load("nope")).toThrow("No saved state 'nope'. Run: pw state list");
	});

	test("rejects a stored file that is not a storage state and names the file", () => {
		mkdirSync(statesDir(), { recursive: true });
		writeFileSync(statePathFor("bad"), '{"hello":1}');
		expect(() => load("bad")).toThrow(`Not a storage state file: ${statePathFor("bad")}`);
	});
});

describe("remove", () => {
	test("deletes a saved state and reports an unknown name", () => {
		save("site", { cookies: [], origins: [] });
		remove("site");
		expect(existsSync(statePathFor("site"))).toBe(false);
		expect(() => remove("site")).toThrow("No saved state 'site'. Run: pw state list");
	});
});

describe("list", () => {
	test("is empty without states", () => {
		expect(list()).toEqual([]);
	});

	test("counts cookies and origins, keeps the top 3 domains by cookie count, and reports the save time", () => {
		save("site", {
			cookies: [
				cookie(".b.test"),
				cookie("b.test"),
				cookie("a.test"),
				cookie("c.test"),
				cookie("c.test"),
				cookie("c.test"),
				cookie("d.test"),
			],
			origins: [{ origin: "https://a.test" }, { origin: "https://b.test" }],
		});
		const when = new Date("2026-01-02T03:04:05.000Z");
		utimesSync(statePathFor("site"), when, when);
		const [summary] = list();
		expect(summary).toEqual({
			name: "site",
			cookies: 7,
			origins: 2,
			domains: ["c.test", "b.test", "a.test"],
			savedAt: "2026-01-02T03:04:05.000Z",
		});
		expect(formatSummary(summary as NonNullable<typeof summary>)).toBe(
			"site  7 cookies  2 origins  c.test,b.test,a.test  2026-01-02T03:04:05.000Z",
		);
	});

	test("prints a dash when no cookie has a domain", () => {
		save("empty", { cookies: [], origins: [] });
		expect(formatSummary(list()[0] as NonNullable<ReturnType<typeof list>[number]>)).toContain("0 origins  -  ");
	});

	test("skips the marker, temporary files, and files that are not storage states", () => {
		save("ok", { cookies: [], origins: [] });
		importLegacyOnce(() => undefined);
		writeFileSync(path.join(statesDir(), "junk.json"), "not json");
		writeFileSync(path.join(statesDir(), "Upper.json"), "{}");
		expect(list().map((s) => s.name)).toEqual(["ok"]);
	});
});

describe("importFile", () => {
	const source = (text: string): string => {
		const file = path.join(stateRoot.dir, "incoming.json");
		writeFileSync(file, text);
		return file;
	};

	test("stores the file under its basename as 0600", () => {
		expect(importFile(source('{"cookies":[],"origins":[]}'))).toBe("incoming");
		expect(mode(statePathFor("incoming"))).toBe(0o600);
	});

	test("uses the given name", () => {
		expect(importFile(source('{"cookies":[]}'), "site")).toBe("site");
		expect(load("site")).toEqual({ cookies: [] });
	});

	test.each(["{}", "[]", "null", '"text"', "not json", '{"cookies":"x"}', '{"origins":{}}', '{"other":[]}'])(
		"refuses %p and names the file",
		(text) => {
			const file = source(text);
			expect(() => importFile(file, "site")).toThrow(`Not a storage state file: ${file}`);
			expect(existsSync(statePathFor("site"))).toBe(false);
		},
	);

	test("reports a missing file", () => {
		expect(() => importFile("/nope/x.json", "site")).toThrow("File not found: /nope/x.json");
	});

	test("rejects an invalid derived name as a usage error", () => {
		const file = path.join(stateRoot.dir, "My State.json");
		writeFileSync(file, '{"cookies":[]}');
		expect(() => importFile(file)).toThrow(UsageError);
	});

	test("rejects a traversal name before reading the file", () => {
		expect(() => importFile("/nope/x.json", "../x")).toThrow(UsageError);
	});
});

describe("importLegacyOnce", () => {
	const text = '{"cookies":[],"origins":[]}';

	test("copies each legacy file once as 0600, leaves sources in place, and reports the count", () => {
		seedLegacy({
			"a.json": text,
			"b.json": text,
			"notes.txt": "x",
			"Bad Name.json": text,
			"broken.json": "nope",
		});
		const lines: string[] = [];
		expect(importLegacyOnce((line) => lines.push(line))).toBe(2);
		expect(lines).toEqual(["Imported 2 legacy states from ~/.cache/playwright-cli/sessions/"]);
		expect(list().map((s) => s.name)).toEqual(["a", "b"]);
		expect(mode(statePathFor("a"))).toBe(0o600);
		expect(readdirSync(legacyDir()).sort()).toEqual(["Bad Name.json", "a.json", "b.json", "broken.json", "notes.txt"]);
		expect(existsSync(path.join(statesDir(), ".legacy-imported"))).toBe(true);
	});

	test("does not run again once the marker exists", () => {
		seedLegacy({ "a.json": text });
		importLegacyOnce(() => undefined);
		seedLegacy({ "late.json": text });
		const lines: string[] = [];
		expect(importLegacyOnce((line) => lines.push(line))).toBe(0);
		expect(lines).toEqual([]);
		expect(list().map((s) => s.name)).toEqual(["a"]);
	});

	test("keeps a state that already exists under the same name", () => {
		save("a", { cookies: [cookie("keep.test")] });
		seedLegacy({ "a.json": text, "b.json": text });
		expect(importLegacyOnce(() => undefined)).toBe(1);
		expect(load("a").cookies).toHaveLength(1);
	});

	test("keeps the source modification time as the save time", () => {
		seedLegacy({ "a.json": text });
		const when = new Date("2025-05-06T07:08:09.000Z");
		utimesSync(path.join(legacyDir(), "a.json"), when, when);
		importLegacyOnce(() => undefined);
		expect(list()[0]?.savedAt).toBe("2025-05-06T07:08:09.000Z");
	});

	test("prints nothing and marks done when there is no legacy directory", () => {
		const lines: string[] = [];
		expect(importLegacyOnce((line) => lines.push(line))).toBe(0);
		expect(lines).toEqual([]);
		expect(existsSync(path.join(statesDir(), ".legacy-imported"))).toBe(true);
	});

	test("never reads or prints file contents", () => {
		seedLegacy({
			"a.json": '{"cookies":[{"name":"sid","value":"SECRET-VALUE"}]}',
		});
		const lines: string[] = [];
		importLegacyOnce((line) => lines.push(line));
		expect(lines.join("\n")).not.toContain("SECRET-VALUE");
		expect(readFileSync(statePathFor("a"), "utf8")).toContain("SECRET-VALUE");
	});
});
