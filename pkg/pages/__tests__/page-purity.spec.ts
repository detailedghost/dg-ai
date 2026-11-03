import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sources = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root })];

test("pkg/pages ships page sources for the chat and board entries", () => {
	expect(sources).toContain("src/chat/main.ts");
	expect(sources).toContain("src/board/main.ts");
});

test("no pkg/pages source imports wxt or touches chrome or browser globals", () => {
	const offenders = sources.filter((file) => {
		const text = readFileSync(join(root, file), "utf8");
		return (
			/from\s+["']wxt(\/[^"']*)?["']/.test(text) ||
			/\bimport\(\s*["']wxt/.test(text) ||
			/\bchrome\.[a-z]/.test(text) ||
			/\bbrowser\.[a-z]/.test(text) ||
			/@\/lib\//.test(text)
		);
	});
	expect(offenders).toEqual([]);
});
