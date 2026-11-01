import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/goto/run";
import spec from "../../../../src/pw/commands/goto/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("goto spec", () => {
	test("requires a url", () => {
		expect(() => argsFor(spec)).toThrow("Missing argument: <url>");
		expect(argsFor(spec, "https://a.test").positionals).toEqual(["https://a.test"]);
	});
});

describe("goto handler", () => {
	test("navigates to the normalized url and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "example.com"));
		expect(page.calls).toEqual(['goto https://example.com {"waitUntil":"load"}']);
		expect(result).toEqual({
			code: 'await page.goto("https://example.com");',
			snapshot: true,
		});
	});
});
