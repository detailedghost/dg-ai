import { describe, expect, test } from "bun:test";
import { bunVersionError } from "../../../src/pw/core/bun-version";

describe("bunVersionError", () => {
	test.each(["1.4.0", "1.4.2", "1.10.0", "2.0.0"])("accepts %p", (version) => {
		expect(bunVersionError(version)).toBeNull();
	});

	test.each(["1.3.11", "1.2.22", "0.9.0", ""])(
		"refuses %p with an upgrade hint",
		(version) => {
			expect(bunVersionError(version)).toContain("pw needs Bun >= 1.4.0");
			expect(bunVersionError(version)).toContain("bun upgrade");
		},
	);
});
