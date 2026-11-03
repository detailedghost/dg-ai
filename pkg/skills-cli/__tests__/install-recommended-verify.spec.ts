import { afterEach, describe, expect, test } from "bun:test";
import { installRecommendedForClaude } from "../src/install/recommended-plugins";
import { removeRecommendedFixtures, tempDir, writeInstalledPlugins } from "./recommended-fixtures";

afterEach(removeRecommendedFixtures);

describe("installRecommendedForClaude post-install verification", () => {
	test("warns when the installed sha is not the pin after a successful install", () => {
		const home = tempDir("recommended-home");
		const pin = "b".repeat(40);
		writeInstalledPlugins(home, {});
		const run = (argv: string[]) => {
			if (argv[2] === "install") {
				writeInstalledPlugins(home, { "unslop@detailedghost": "c".repeat(40) });
			}
			return { status: 0, stdout: "{}", stderr: "" };
		};
		const lines: string[] = [];
		installRecommendedForClaude([{ name: "unslop", repo: "owner/unslop", sha: pin }], home, run, (line) =>
			lines.push(line),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^⚠ unslop/);
	});
});
