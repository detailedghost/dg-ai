import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

describe("skills-cli ships channel-review", () => {
	test("depends on @dg/channel-review through the workspace", () => {
		const manifest = JSON.parse(read("pkg", "skills-cli", "package.json"));
		expect(manifest.dependencies["@dg/channel-review"]).toBe("workspace:*");
	});

	test("skills-blt.yml watches pkg/channel-review with 6 spaces of indent inside the contiguous paths block", () => {
		const block = /paths:\n((?: {6}- \S+\n)+)/.exec(read(".github", "workflows", "skills-blt.yml"))?.[1] ?? "";
		expect(block).toContain("      - pkg/channel-review/**\n");
	});

	test("skills-blt runs channel-review lint and test after common and before skills-cli", () => {
		const text = read(".github", "workflows", "skills-blt.yml");
		const at = (needle: string) => text.indexOf(needle);
		const lint = at("pkg/channel-review\n        run: bun run lint");
		const test_ = at("pkg/channel-review\n        run: bun test");
		expect(lint).toBeGreaterThan(-1);
		expect(test_).toBeGreaterThan(-1);
		expect(lint).toBeGreaterThan(at("working-directory: pkg/common\n        run: bun test"));
		expect(test_).toBeLessThan(at("working-directory: pkg/skills-cli\n        run: bun run lint"));
	});
});
