import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/tab-close/run";
import spec from "../../../../src/pw/commands/tab-close/spec";
import {
	argsFor,
	FakePage,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

function twoTabs() {
	const { ctx, page, context } = fakeCtx(scratch.dir);
	const second = new FakePage();
	const pages = [page, second] as unknown as ReturnType<typeof context.pages>;
	(context as unknown as { pages: () => unknown }).pages = () => pages;
	ctx.selectTab(1);
	return { ctx, first: page, second };
}

describe("tab-close", () => {
	test("closes the current tab and selects the previous one", async () => {
		const { ctx, first, second } = twoTabs();
		const result = await handler(ctx, argsFor(spec));
		expect(second.calls).toEqual(["close []"]);
		expect(ctx.page()).toBe(first as never);
		expect(result.code).toBe(
			"await page.close();\npage = page.context().pages()[0];",
		);
	});

	test("rebinds page when the current tab is closed by its index", async () => {
		const { ctx, first, second } = twoTabs();
		const result = await handler(ctx, argsFor(spec, "1"));
		expect(second.calls).toEqual(["close []"]);
		expect(ctx.page()).toBe(first as never);
		expect(result.code).toBe(
			"await page.context().pages()[1].close();\npage = page.context().pages()[0];",
		);
	});

	test("closes another tab by index and keeps the current one", async () => {
		const { ctx, first, second } = twoTabs();
		const result = await handler(ctx, argsFor(spec, "0"));
		expect(first.calls).toEqual(["close []"]);
		expect(ctx.page()).toBe(second as never);
		expect(result.code).toBe("await page.context().pages()[0].close();");
	});

	test("rejects an index that does not exist", async () => {
		const { ctx } = twoTabs();
		await expect(handler(ctx, argsFor(spec, "5"))).rejects.toThrow(
			"Tab 5 does not exist",
		);
	});
});
