import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

describe("review-loop proxy workflow", () => {
	test("resolves the diff base inline instead of linking to an unshipped review skill", () => {
		const workflow = readRepoFile(
			"plugins",
			"dg",
			"skills",
			"review-loop",
			"references",
			"proxy-workflow.md",
		);
		expect(workflow).not.toContain("review/SKILL.md");
		expect(workflow).toContain("git merge-base HEAD");
		expect(workflow).toContain("origin/HEAD");
	});
});