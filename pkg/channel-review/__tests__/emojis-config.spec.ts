import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { SLOT_KEYS, loadConfig, saveReactionSlot } from "../src/config";
import { type TempHome, createTempHome, minimalConfigJson, writeConfigFile } from "./support/fakes";

const HEX = "0123456789abcdef0123456789abcdef";
const valid = `blob;0-cus-d3-${HEX}`;

let home: TempHome;

beforeEach(() => {
	home = createTempHome();
});

afterEach(() => {
	home.cleanup();
});

describe("SLOT_KEYS", () => {
	test("maps progress to inProgress and approved to approved", () => {
		expect(SLOT_KEYS).toEqual({ progress: "inProgress", approved: "approved" });
	});
});

describe("saveReactionSlot", () => {
	test("creates the reactions object on a config without one", () => {
		const path = writeConfigFile(home.dir);
		saveReactionSlot(path, "inProgress", valid);
		expect(JSON.parse(readFileSync(path, "utf8")).reactions).toEqual({ inProgress: valid });
		expect(loadConfig(path).reactions.inProgress).toBe(valid);
	});

	test("replaces only the named slot and keeps the other reactions", () => {
		const path = writeConfigFile(
			home.dir,
			minimalConfigJson({ reactions: { approved: "2705_whiteheavycheckmark", failure: "x" } }),
		);
		saveReactionSlot(path, "inProgress", valid);
		expect(JSON.parse(readFileSync(path, "utf8")).reactions).toEqual({
			approved: "2705_whiteheavycheckmark",
			failure: "x",
			inProgress: valid,
		});
	});

	test("saves the approved slot under reactions.approved", () => {
		const path = writeConfigFile(home.dir);
		saveReactionSlot(path, "approved", valid);
		expect(loadConfig(path).reactions.approved).toBe(valid);
	});

	test("throws a DgCliError naming the path on invalid JSON and leaves the file", () => {
		const path = join(home.dir, "config.json");
		writeFileSync(path, "{ nope");
		expect(() => saveReactionSlot(path, "inProgress", valid)).toThrow(DgCliError);
		expect(() => saveReactionSlot(path, "inProgress", valid)).toThrow(path);
		expect(readFileSync(path, "utf8")).toBe("{ nope");
	});

	test("throws a DgCliError naming the path when the file is missing and never creates it", () => {
		const path = join(home.dir, "missing.json");
		expect(() => saveReactionSlot(path, "inProgress", valid)).toThrow(DgCliError);
		expect(() => saveReactionSlot(path, "inProgress", valid)).toThrow(path);
		expect(() => readFileSync(path, "utf8")).toThrow();
	});

	test("rejects an id that is not a custom reaction id and leaves the file untouched", () => {
		const path = writeConfigFile(home.dir);
		const before = readFileSync(path, "utf8");
		expect(() => saveReactionSlot(path, "inProgress", "progress;0-cus-d4-abc")).toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});
