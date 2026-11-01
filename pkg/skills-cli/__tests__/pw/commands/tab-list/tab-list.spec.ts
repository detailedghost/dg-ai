import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/tab-list/run";
import spec from "../../../../src/pw/commands/tab-list/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("tab-list", () => {
	test("marks the current tab and shows index, title, and url", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(result.result).toBe("- 0: (current) [Example](https://example.test/)");
	});

	test("says so when no tab is open", async () => {
		const { ctx, context } = fakeCtx(scratch.dir);
		(context as unknown as { pages: () => never[] }).pages = () => [];
		const result = await handler(ctx, argsFor(spec));
		expect(result.result).toBe("No open tabs. Navigate to a URL to create one.");
	});
});
