import { describe, expect, test } from "bun:test";
import { protectedPushReason } from "../src/protected-branch";

describe("protectedPushReason", () => {
	test("protects main, master, and the repository default branch", () => {
		expect(protectedPushReason("main")).toBe(
			"refusing to force-push protected branch 'main'",
		);
		expect(protectedPushReason("master", "develop")).toBe(
			"refusing to force-push protected branch 'master'",
		);
		expect(protectedPushReason("develop", "develop")).toBe(
			"refusing to force-push protected branch 'develop'",
		);
	});

	test("allows a feature branch", () => {
		expect(protectedPushReason("feature/meaningful", "main")).toBeUndefined();
		expect(protectedPushReason("develop", "main")).toBeUndefined();
	});
});
