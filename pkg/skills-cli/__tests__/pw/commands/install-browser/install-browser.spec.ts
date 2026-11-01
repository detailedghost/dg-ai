import { describe, expect, test } from "bun:test";
import spec from "../../../../src/pw/commands/install-browser/spec";
import { argsFor } from "../../../../src/pw/test-support";

describe("install-browser spec", () => {
	test("is a core client command without positionals", () => {
		expect(spec).toMatchObject({
			name: "install-browser",
			group: "core",
			side: "client",
		});
		expect(argsFor(spec).positionals).toEqual([]);
	});
});
