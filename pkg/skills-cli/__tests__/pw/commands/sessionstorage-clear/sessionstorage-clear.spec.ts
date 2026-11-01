import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/sessionstorage-clear/run";
import spec from "../../../../src/pw/commands/sessionstorage-clear/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("sessionstorage-clear", () => {
	test("clears the storage", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.evaluateArgs).toEqual(["sessionStorage"]);
		expect(result.code).toBe(
			"await page.evaluate(() => sessionStorage.clear());",
		);
	});
});
