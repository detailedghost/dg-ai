import { describe, expect, test } from "bun:test";
import { defaultProfileDir } from "../../../src/pw/core/profiles";

describe("defaultProfileDir", () => {
	test("keeps the legacy profile location", () => {
		const previous = process.env["XDG_CACHE_HOME"];
		process.env["XDG_CACHE_HOME"] = "/cache";
		try {
			expect(defaultProfileDir("timesheet")).toBe("/cache/playwright-cli/profiles/timesheet");
		} finally {
			if (previous === undefined) delete process.env["XDG_CACHE_HOME"];
			else process.env["XDG_CACHE_HOME"] = previous;
		}
	});
});
