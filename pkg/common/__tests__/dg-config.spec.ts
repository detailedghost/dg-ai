import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
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
import { readDgConfig, writeDgConfig } from "../src/node/dg-config";

let home: string;
let env: Record<string, string>;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-config-"));
	env = { DG_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("readDgConfig", () => {
	test("reads an empty config when the file is missing", () => {
		expect(readDgConfig(env)).toEqual({});
	});

	test("reads config.json from the state dir", () => {
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({ hooks: { spelling: { locale: "en-GB" } } }),
		);
		expect(readDgConfig(env)).toEqual({
			hooks: { spelling: { locale: "en-GB" } },
		});
	});

	test("throws on invalid JSON", () => {
		writeFileSync(join(home, "config.json"), "{nope");
		expect(() => readDgConfig(env)).toThrow();
	});
});

describe("readDgConfig top-level shape", () => {
	test.each([
		["an array", "[1, 2]"],
		["a string", '"en-GB"'],
		["a number", "7"],
		["null", "null"],
	])("throws when the top level is %s", (_name, text) => {
		writeFileSync(join(home, "config.json"), text);
		expect(() => readDgConfig(env)).toThrow("not a JSON object");
	});
});

describe("writeDgConfig top-level shape and keys", () => {
	test.each([
		["an array", "[1, 2]"],
		["a string", '"en-GB"'],
	])("does not overwrite a config whose top level is %s", (_name, text) => {
		writeFileSync(join(home, "config.json"), text);
		expect(() => writeDgConfig({ a: 1 }, env)).toThrow();
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe(text);
	});

	test("does not store a __proto__ key or pollute Object.prototype", () => {
		const patch = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
		writeDgConfig(patch, env);
		const stored = readDgConfig(env);
		expect(Object.hasOwn(stored, "__proto__")).toBe(false);
		expect(stored["polluted"]).toBeUndefined();
		expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
		expect(stored).toEqual({ a: 1 });
	});
});

describe("writeDgConfig", () => {
	test("creates the file and the state dir when absent", () => {
		const nested = { DG_HOME: join(home, "fresh") };
		writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, nested);
		expect(readDgConfig(nested)).toEqual({
			hooks: { spelling: { locale: "en-GB" } },
		});
	});

	test("keeps unknown keys and merges nested objects", () => {
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({ other: 1, hooks: { format: { x: true } } }),
		);
		writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, env);
		expect(readDgConfig(env)).toEqual({
			other: 1,
			hooks: { format: { x: true }, spelling: { locale: "en-GB" } },
		});
	});

	test("rewrites the file and leaves no temp file", () => {
		writeDgConfig({ a: 1 }, env);
		writeDgConfig({ a: 2 }, env);
		expect(readdirSync(home)).toEqual(["config.json"]);
		expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual(
			{ a: 2 },
		);
	});

	test("does not overwrite a config that is not valid JSON", () => {
		writeFileSync(join(home, "config.json"), "{nope");
		expect(() => writeDgConfig({ a: 1 }, env)).toThrow();
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{nope");
	});

	test("does not store a nested __proto__ key", () => {
		const patch = JSON.parse('{"hooks": {"__proto__": {"x": 1}, "y": 2}}');
		writeDgConfig(patch, env);
		const stored = readDgConfig(env) as { hooks: Record<string, unknown> };
		expect(Object.hasOwn(stored.hooks, "__proto__")).toBe(false);
		expect(stored.hooks["y"]).toBe(2);
	});
});

describe("writeDgConfig file handling", () => {
	test.skipIf(process.platform === "win32")(
		"creates a new config.json with mode 0600",
		() => {
			writeDgConfig({ a: 1 }, env);
			expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
		},
	);

	test.skipIf(process.platform === "win32")(
		"writes through a symlink and keeps the link and the target mode",
		() => {
			const target = join(home, "dotfiles", "config.json");
			mkdirSync(join(home, "dotfiles"));
			writeFileSync(target, JSON.stringify({ keep: true }));
			chmodSync(target, 0o640);
			symlinkSync(target, join(home, "config.json"));
			writeDgConfig({ a: 1 }, env);
			expect(lstatSync(join(home, "config.json")).isSymbolicLink()).toBe(true);
			expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
				keep: true,
				a: 1,
			});
			expect(statSync(target).mode & 0o777).toBe(0o640);
		},
	);

	test.skipIf(process.platform === "win32")(
		"refuses a dangling symlink and keeps the link",
		() => {
			symlinkSync(join(home, "missing.json"), join(home, "config.json"));
			expect(() => writeDgConfig({ a: 1 }, env)).toThrow(
				"symlink to a missing file",
			);
			expect(lstatSync(join(home, "config.json")).isSymbolicLink()).toBe(true);
		},
	);
});
