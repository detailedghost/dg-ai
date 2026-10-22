import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/localstorage-get/run";
import spec from "../../../src/pw/commands/localstorage-get/spec";

const scratch = useTempScratch();

describe("localstorage-get", () => {
	test("prints the value", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.evaluated = "dark";
		const result = await handler(ctx, argsFor(spec, "theme"));
		expect(page.evaluateArgs).toEqual([["localStorage", "theme"]]);
		expect(result.result).toBe("dark");
	});

	test("says so when the key is missing", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.evaluated = null;
		expect((await handler(ctx, argsFor(spec, "theme"))).result).toBe("Key 'theme' not found in localStorage");
	});
});
