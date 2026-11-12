import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dir, "../..");
const SPAWN_OF_CLI_DEST = /\bspawn(?:Sync)?\(\s*cliDest\(/;

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\./.test(name)) out.push(full);
	}
	return out;
}

describe("in-tree spawns", () => {
	it("scans every package src tree", () => {
		const files = readdirSync(PKG_ROOT)
			.map((pkg) => join(PKG_ROOT, pkg, "src"))
			.filter((dir) => {
				try {
					return statSync(dir).isDirectory();
				} catch {
					return false;
				}
			})
			.flatMap(sourceFiles);
		expect(files.length).toBeGreaterThan(100);
	});

	it("never spawn(cliDest(...)) or spawnSync(cliDest(...)) outside __tests__", () => {
		const offenders: string[] = [];
		for (const pkg of readdirSync(PKG_ROOT)) {
			const src = join(PKG_ROOT, pkg, "src");
			try {
				if (!statSync(src).isDirectory()) continue;
			} catch {
				continue;
			}
			for (const file of sourceFiles(src)) {
				if (SPAWN_OF_CLI_DEST.test(readFileSync(file, "utf8"))) offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});
