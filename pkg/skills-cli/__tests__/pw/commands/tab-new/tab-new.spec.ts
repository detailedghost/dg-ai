import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/tab-new/run";
import spec from "../../../../src/pw/commands/tab-new/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("tab-new", () => {
	test("opens a blank tab and selects it", async () => {
		const { ctx, page, context } = fakeCtx(scratch.dir);
		const created = new (page.constructor as new () => typeof page)();
		context.returns["newPage"] = created;
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toContain("context.newPage []");
		expect(result.code).toBe("await page.context().newPage();");
		expect(result.snapshot).toBe(true);
	});

	test("navigates the new tab to the normalized url", async () => {
		const { ctx, page, context } = fakeCtx(scratch.dir);
		const created = new (page.constructor as new () => typeof page)();
		context.returns["newPage"] = created;
		const result = await handler(ctx, argsFor(spec, "example.com"));
		expect(created.calls).toEqual(['goto https://example.com {"waitUntil":"load"}']);
		expect(result.code).toContain('await page.goto("https://example.com");');
	});
});
