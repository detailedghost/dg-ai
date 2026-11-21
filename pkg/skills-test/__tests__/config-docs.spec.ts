import { describe, expect, test } from "bun:test";
import { DG_TOML_DEFAULTS, DG_TOML_SECTIONS } from "../../common/src/node/dg-toml";
import { readRepoFile } from "./test-support";

const DOC = readRepoFile("docs", "config.md");

const PATTERN_KEYS = [
	"hooks.<id>.<setting>",
	"refs.default_repo",
	"refs.aliases.<name>",
	"inbox.<group>.<setting>",
	"plugins.<name>.enabled",
	"plugins.<name>.source",
	"plugins.<name>.settings",
	"meta.migrated",
];

describe("docs/config.md", () => {
	test("names every section of the schema", () => {
		for (const section of DG_TOML_SECTIONS) expect([section, DOC.includes(`\`${section}.`)]).toEqual([section, true]);
	});

	test("names every key of the schema", () => {
		for (const key of [...Object.keys(DG_TOML_DEFAULTS), ...PATTERN_KEYS]) expect([key, DOC.includes(`\`${key}\``)]).toEqual([key, true]);
	});

	test("says where each old file went and where its backup is", () => {
		for (const old of ["config.json", "cli-only", "browser-batch/config.json", "organizer.config.json", "ssms/config.yaml"])
			expect([old, DOC.includes(`${old}.pre-toml`)]).toEqual([old, true]);
	});
});
