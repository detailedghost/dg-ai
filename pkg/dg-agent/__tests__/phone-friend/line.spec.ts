import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { DEFAULT_LINE, linePaths } from "../../src/phone-friend/line";

const paths = resolveDgPaths({ env: { DG_HOME: "/tmp/dg-home" } });

describe("linePaths", () => {
	it("puts each line in its own dir under the phone-friend root", () => {
		const work = linePaths(paths, "work");

		expect(work.dir).toBe(join(paths.phoneFriendRoot, "work"));
		expect(linePaths(paths).name).toBe(DEFAULT_LINE);
		expect(linePaths(paths).dir).not.toBe(work.dir);
	});

	it("names the database file with a .db suffix", () => {
		expect(linePaths(paths).dbPath).toEndWith(".db");
		expect(linePaths(paths, "work").dbPath).toBe(join(paths.phoneFriendRoot, "work", "phone-friend.db"));
	});

	it("rejects a line name that could escape the root or is not simple", () => {
		for (const bad of ["", "../x", "a/b", "Work", "-x", "x".repeat(33)]) {
			expect(() => linePaths(paths, bad)).toThrow(DgCliError);
		}
	});
});
