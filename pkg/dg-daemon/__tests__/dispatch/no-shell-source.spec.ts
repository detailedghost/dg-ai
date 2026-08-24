import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DISPATCH_ROOT = join(import.meta.dir, "../../src/dispatch");

function listTsFiles(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.flatMap((name) => {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return listTsFiles(full);
		return name.endsWith(".ts") ? [full] : [];
	});
}

const BANNED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /Bun\.\$/, label: "Bun.$" },
	{
		pattern: /import\s*\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/,
		label: '$ imported from "bun"',
	},
	{
		pattern: /import\s+\$\s+from\s*["']bun["']/,
		label: '$ imported from "bun"',
	},
	{ pattern: /\bshell\s*:/, label: "a shell option" },
	{ pattern: /\bsh\b/, label: '"sh"' },
	{ pattern: /\bbash\b/, label: '"bash"' },
	{ pattern: /\/bin\/sh/, label: "/bin/sh" },
	{ pattern: /cmd\.exe/i, label: "cmd.exe" },
	{ pattern: /powershell/i, label: "powershell" },
	{ pattern: /["']-c["']/, label: 'a "-c" flag' },
];

describe("src/dispatch/** source inspection", () => {
	it("contains dispatch source files to inspect", () => {
		expect(listTsFiles(DISPATCH_ROOT).length).toBeGreaterThan(0);
	});

	it("never reaches a shell, a script-host flag, or Bun's own shell helper", () => {
		const offenses: string[] = [];
		for (const file of listTsFiles(DISPATCH_ROOT)) {
			const text = readFileSync(file, "utf8");
			for (const { pattern, label } of BANNED_PATTERNS) {
				if (pattern.test(text)) offenses.push(`${file}: ${label}`);
			}
		}
		expect(offenses).toEqual([]);
	});
});
