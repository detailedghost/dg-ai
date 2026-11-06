import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");
const COMMANDS_DIR = join(SRC, "commands");
const ALLOWED = new Set([
	"commander",
	"../utils/lazy-command",
	"../utils/legacy-command",
	"../utils/cli-only",
	"../utils/ext-flag",
	"./demo",
]);

const GOLDEN_COMMANDS = [
	"inbox",
	"channel-review",
	"credentials",
	"db",
	"erd",
	"test-live",
	"install",
	"batch-open",
	"launch",
	"demo",
	"rerun",
	"stash",
	"address",
	"thrash",
	"chain",
	"catchup",
	"file",
	"hooks",
	"deps-upgrade",
	"meaningful",
	"vcs-provider",
	"clipboard-image",
	"proto",
	"prototype",
	"verify",
	"proxy",
	"pw",
	"pw-code",
	"overwatch-snapshot",
	"worktree",
	"spec",
	"assign",
	"monolith",
	"jot",
	"bg",
	"stat",
	"sniff",
	"ssms",
	"doctor",
	"clean",
	"require-extension",
];

function staticValueImports(source: string): string[] {
	const found: string[] = [];
	const importRe = /^\s*import\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
	for (const match of source.matchAll(importRe)) {
		const [, typeOnly, clause, specifier, bare] = match;
		if (bare) {
			found.push(bare);
			continue;
		}
		if (typeOnly) continue;
		const allInlineTypes =
			/^\{[^}]*\}$/.test(clause.trim()) &&
			clause
				.replace(/[{}]/g, "")
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean)
				.every((part) => part.startsWith("type "));
		if (!allInlineTypes) found.push(specifier);
	}
	return found;
}

describe("src/commands wrappers", () => {
	const files = readdirSync(COMMANDS_DIR).filter((name) => name.endsWith(".ts"));

	it("finds the command wrapper files", () => {
		expect(files.length).toBeGreaterThan(30);
	});

	for (const file of files) {
		it(`${file} has no static value import outside the lazy-loading allowlist`, () => {
			const imports = staticValueImports(readFileSync(join(COMMANDS_DIR, file), "utf8"));
			const offenders = imports.filter((specifier) => !ALLOWED.has(specifier));
			expect(offenders).toEqual([]);
		});
	}
});

describe("dg-skills --help", () => {
	it("lists the same command names as before", async () => {
		const proc = Bun.spawn([process.execPath, join(SRC, "index.ts"), "--help"], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: { ...process.env, NO_COLOR: "1" },
		});
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(code).toBe(0);
		const section = stdout.split(/^Commands:\n/m)[1] ?? "";
		const names = section
			.split("\n")
			.filter((line) => /^ {2}[a-z]/.test(line))
			.map((line) => line.trim().split(/\s+/)[0])
			.filter((name) => name !== "help");
		expect(names).toEqual(GOLDEN_COMMANDS);
	});
});
