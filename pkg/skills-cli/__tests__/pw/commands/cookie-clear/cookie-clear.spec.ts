import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/cookie-clear/run";
import spec from "../../../../src/pw/commands/cookie-clear/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("cookie-clear", () => {
	test("clears every cookie", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual(["context.clearCookies []"]);
		expect(result.code).toBe("await page.context().clearCookies();");
	});
});
