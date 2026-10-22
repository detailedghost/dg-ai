import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/localstorage-clear/run";
import spec from "../../../src/pw/commands/localstorage-clear/spec";

const scratch = useTempScratch();

describe("localstorage-clear", () => {
	test("clears the storage", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.evaluateArgs).toEqual(["localStorage"]);
		expect(result.code).toBe("await page.evaluate(() => localStorage.clear());");
	});
});
