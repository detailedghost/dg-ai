import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/type/run";
import spec from "../../../../src/pw/commands/type/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("type spec", () => {
	test("requires text and accepts --submit", () => {
		expect(() => argsFor(spec)).toThrow("Missing argument: <text>");
		expect(argsFor(spec, "hi", "--submit").flags).toEqual({ submit: true });
	});
});

describe("type handler", () => {
	test("types into the focused element", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "hello"));
		expect(page.calls).toEqual(["type hello"]);
		expect(result).toEqual({
			code: 'await page.keyboard.type("hello");',
			snapshot: true,
		});
	});

	test("presses Enter after typing when --submit is set", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "hello", "--submit"));
		expect(page.calls).toEqual(["type hello", "press Enter"]);
	});
});
