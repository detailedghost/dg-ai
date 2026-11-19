import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isUnder } from "../../skills-cli/__tests__/path-under";

describe("test home fence environment", () => {
	it("keeps DG_HOME, HOME and USERPROFILE below the temp dir", () => {
		for (const key of ["DG_HOME", "HOME", "USERPROFILE"]) {
			expect(isUnder(tmpdir(), process.env[key])).toBe(true);
		}
	});

	it("limits the DG path fence to the temp dir", () => {
		expect(process.env.DG_PATH_FENCE).toBe(resolve(tmpdir()));
	});
});
