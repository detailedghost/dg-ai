import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/cookie-delete/run";
import spec from "../../../../src/pw/commands/cookie-delete/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("cookie-delete", () => {
	test("clears only the named cookie", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "sid"));
		expect(page.calls).toEqual(['context.clearCookies [{"name":"sid"}]']);
		expect(result.code).toBe('await page.context().clearCookies({ name: "sid" });');
	});
});
