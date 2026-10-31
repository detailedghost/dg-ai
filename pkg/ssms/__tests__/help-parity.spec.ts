import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, renderHelp } from "../src/cli/catalog";
import { parseCleanupYaml } from "../src/config/parse";
import { defaultCleanupConfig } from "../src/config/types";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("ssms help parity", () => {
	test("docs/ssms.md lists every command line from --help", () => {
		const help = renderHelp();
		const docs = readFileSync(join(repoRoot, "docs", "ssms.md"), "utf8");
		expect(help).toContain("Providers: google, signal");
		for (const command of COMMANDS) {
			expect(help).toContain(command.usage);
			expect(docs).toContain(command.usage);
		}
	});
});

describe("skill config parity", () => {
	test("the skill YAML block is the default cleanup config", () => {
		const skill = readFileSync(
			join(repoRoot, "plugins", "dg", "skills", "google-sms-cleanup", "SKILL.md"),
			"utf8",
		);
		const block = /```yaml\n([\s\S]*?)\n```/.exec(skill)?.[1];
		expect(block).toBeDefined();
		expect(parseCleanupYaml(block ?? "")).toEqual(defaultCleanupConfig());
	});
});
