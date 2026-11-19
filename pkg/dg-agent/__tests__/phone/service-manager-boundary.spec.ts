import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

describe("dg-agent service manager boundary", () => {
	it("keeps every systemctl, launchctl and schtasks command out of pkg/dg-agent/src", () => {
		const offenders = sourceFiles(SRC).filter((file) => /systemctl|launchctl|schtasks/.test(readFileSync(file, "utf8")));

		expect(offenders).toEqual([]);
	});

	it("holds the autostart module in common, not in the phone folder", () => {
		expect(existsSync(join(SRC, "phone", "autostart.ts"))).toBe(false);
	});
});
