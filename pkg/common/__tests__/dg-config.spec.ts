import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
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
let dir: string;
let toml: string;
let env: Record<string, string>;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-config-"));
	dir = join(home, "config");
	mkdirSync(dir);
	toml = join(dir, "config.toml");
	env = { DG_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("readDgConfig", () => {
	test("reads an empty config when no file exists", () => {
		expect(readDgConfig(env)).toEqual({});
	});

	test("reads the [hooks] table of config.toml", () => {
		writeFileSync(toml, '[hooks.spelling]\nlocale = "en-GB"\n');

		expect(readDgConfig(env)).toEqual({ hooks: { spelling: { locale: "en-GB" } } });
	});

	test("does not open config.json once config.toml exists", () => {
		writeFileSync(toml, '[hooks.spelling]\nlocale = "en-GB"\n');
		writeFileSync(join(dir, "config.json"), "{nope");

		expect(readDgConfig(env)).toEqual({ hooks: { spelling: { locale: "en-GB" } } });
	});

	test("reads the hooks of config.json before migration", () => {
		writeFileSync(join(dir, "config.json"), JSON.stringify({ hooks: { spelling: { locale: "en-GB" } } }));

		expect(readDgConfig(env)).toEqual({ hooks: { spelling: { locale: "en-GB" } } });
	});

	test("throws on invalid TOML", () => {
		writeFileSync(toml, "[hooks\n");

		expect(() => readDgConfig(env)).toThrow("dg config:");
	});
});

describe("writeDgConfig", () => {
	test.skipIf(process.platform === "win32")("creates config.toml with mode 0600 and the config dir when absent", () => {
		const fresh = { DG_HOME: join(home, "fresh") };

		writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, fresh);

		expect(readDgConfig(fresh)).toEqual({ hooks: { spelling: { locale: "en-GB" } } });
		expect(statSync(join(home, "fresh", "config", "config.toml")).mode & 0o777).toBe(0o600);
	});

	test("merges into the hooks already stored", () => {
		writeFileSync(toml, '[hooks.format]\nmode = "on"\n');

		writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, env);

		expect(readDgConfig(env)).toEqual({ hooks: { format: { mode: "on" }, spelling: { locale: "en-GB" } } });
	});

	test("migrates config.json first and changes only config.toml", () => {
		const json = join(dir, "config.json");
		const text = JSON.stringify({ hooks: { format: { mode: "on" } } });
		writeFileSync(json, text);

		writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, env);

		expect(readFileSync(json, "utf8")).toBe(text);
		expect(readFileSync(`${json}.pre-toml`, "utf8")).toBe(text);
		expect(readDgConfig(env)).toEqual({ hooks: { format: { mode: "on" }, spelling: { locale: "en-GB" } } });
	});

	test("refuses a key outside a dg config section", () => {
		expect(() => writeDgConfig({ other: 1 }, env)).toThrow("not a dg config section");
		expect(existsSync(toml)).toBe(false);
	});

	test("does not store a __proto__ key or pollute Object.prototype", () => {
		const patch = JSON.parse('{"hooks": {"__proto__": {"polluted": "yes"}, "spelling": {"locale": "en-GB"}}}');

		writeDgConfig(patch, env);

		expect(readDgConfig(env)).toEqual({ hooks: { spelling: { locale: "en-GB" } } });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("does not overwrite a config.toml that is not valid TOML", () => {
		writeFileSync(toml, "[hooks\n");

		expect(() => writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, env)).toThrow();
		expect(readFileSync(toml, "utf8")).toBe("[hooks\n");
	});
});

describe("writeDgConfig file handling", () => {
	test("leaves no temp file after two writes", () => {
		writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, env);
		writeDgConfig({ hooks: { spelling: { locale: "en-US" } } }, env);

		expect(readdirSync(dir)).toEqual(["config.toml"]);
	});

	test.skipIf(process.platform === "win32")("writes through a symlink and keeps the link and the target mode", () => {
		const target = join(home, "dotfiles", "config.toml");
		mkdirSync(join(home, "dotfiles"));
		writeFileSync(target, '[hooks.format]\nmode = "on"\n');
		chmodSync(target, 0o640);
		symlinkSync(target, toml);

		writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, env);

		expect(lstatSync(toml).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toContain('locale = "en-GB"');
		expect(statSync(target).mode & 0o777).toBe(0o640);
	});

	test.skipIf(process.platform === "win32")("refuses a dangling symlink and keeps the link", () => {
		symlinkSync(join(home, "missing.toml"), toml);

		expect(() => writeDgConfig({ hooks: { spelling: { locale: "en-GB" } } }, env)).toThrow("symlink to a missing file");
		expect(lstatSync(toml).isSymbolicLink()).toBe(true);
	});
});
