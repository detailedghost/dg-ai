import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/press/run";
import spec from "../../../../src/pw/commands/press/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("press", () => {
	test("requires a key", () => {
		expect(() => argsFor(spec)).toThrow("Missing argument: <key>");
	});

	test("presses the key and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "ArrowDown"));
		expect(page.calls).toEqual(["press ArrowDown"]);
		expect(result).toEqual({
			code: 'await page.keyboard.press("ArrowDown");',
			snapshot: true,
		});
	});

	test("accepts lowercase key names", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "arrowleft"));
		expect(page.calls).toEqual(["press ArrowLeft"]);
	});
});
