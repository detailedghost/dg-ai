import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/hover/run";
import spec from "../../../src/pw/commands/hover/spec";

const scratch = useTempScratch();

describe("hover", () => {
	test("hovers the target and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "e5"));
		expect(page.locator("aria-ref=e5").calls).toEqual(["hover []"]);
		expect(result).toEqual({ code: "await page.locator('aria-ref=e5').hover();", snapshot: true });
	});

	test("fails with the fixed message when the ref is gone", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.missing("aria-ref=e9");
		await expect(handler(ctx, argsFor(spec, "e9"))).rejects.toThrow("Ref not found: e9. Take a new snapshot.");
	});
});
