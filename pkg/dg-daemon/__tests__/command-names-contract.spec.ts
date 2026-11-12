import { describe, expect, it } from "bun:test";
import { captureProgram, underscored } from "../../common/__tests__/utils/command-names";

const registered = captureProgram();

describe("registered command names", () => {
	it("has no command whose name starts with a double underscore", async () => {
		const all = await registered(() => import("../src/main"));

		expect(all.length).toBeGreaterThan(0);
		expect(underscored(all)).toEqual([]);
	});

	it("registers the visible replacements", async () => {
		expect(await registered(() => import("../src/main"))).toContain("serve");
	});
});
