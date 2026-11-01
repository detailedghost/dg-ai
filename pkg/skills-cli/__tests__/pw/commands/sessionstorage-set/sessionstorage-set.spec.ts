import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/sessionstorage-set/run";
import spec from "../../../../src/pw/commands/sessionstorage-set/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("sessionstorage-set", () => {
	test("passes the key and value as data, never as code", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "k", "'); alert(1); ('"));
		expect(page.evaluateArgs).toEqual([["sessionStorage", "k", "'); alert(1); ('"]]);
		expect(result.code).toStartWith("await page.evaluate(() => sessionStorage.setItem(");
	});
});
