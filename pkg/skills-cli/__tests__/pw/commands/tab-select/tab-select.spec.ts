import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/tab-select/run";
import spec from "../../../../src/pw/commands/tab-select/spec";
import { argsFor, FakePage, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("tab-select", () => {
	test("selects the tab, brings it to the front, and lists the tabs", async () => {
		const { ctx, page, context } = fakeCtx(scratch.dir);
		const second = new FakePage();
		(context as unknown as { pages: () => unknown[] }).pages = () => [page, second];
		const result = await handler(ctx, argsFor(spec, "1"));
		expect(second.calls).toContain("bringToFront []");
		expect(ctx.page()).toBe(second as never);
		expect(result.result).toContain("- 1: (current)");
	});

	test("rejects an index that is not a tab", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "3"))).rejects.toThrow("Tab 3 does not exist");
		await expect(handler(ctx, argsFor(spec, "x"))).rejects.toThrow("Tab x does not exist");
	});
});
