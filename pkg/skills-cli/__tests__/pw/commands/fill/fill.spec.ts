import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/fill/run";
import spec from "../../../../src/pw/commands/fill/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("fill spec", () => {
	test("requires a target and text", () => {
		expect(() => argsFor(spec, "e1")).toThrow("Missing argument: <text>");
		expect(argsFor(spec, "e1", "hello", "--submit").flags).toEqual({
			submit: true,
		});
	});
});

describe("fill handler", () => {
	test("fills the element and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "e6", "hello world"));
		expect(page.locator("aria-ref=e6").calls).toEqual(["fill hello world"]);
		expect(result).toEqual({
			code: "await page.locator('aria-ref=e6').fill(\"hello world\");",
			snapshot: true,
		});
	});

	test("presses Enter on the element after filling when --submit is set", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "e6", "x", "--submit"));
		expect(page.locator("aria-ref=e6").calls).toEqual([
			"fill x",
			"press Enter",
		]);
		expect(result.code).toContain('.press("Enter")');
	});

	test("fails with the fixed message when the ref is gone", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.missing("aria-ref=e6");
		await expect(handler(ctx, argsFor(spec, "e6", "x"))).rejects.toThrow(
			"Ref not found: e6",
		);
	});
});
