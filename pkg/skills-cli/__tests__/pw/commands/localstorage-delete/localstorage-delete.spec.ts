import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/localstorage-delete/run";
import spec from "../../../../src/pw/commands/localstorage-delete/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("localstorage-delete", () => {
	test("removes the key", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "theme"));
		expect(page.evaluateArgs).toEqual([["localStorage", "theme"]]);
		expect(result.code).toBe('await page.evaluate(() => localStorage.removeItem("theme"));');
	});
});
