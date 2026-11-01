import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import handler, {
	isFunctionLike,
	toEvaluable,
} from "../../../../src/pw/commands/eval/run";
import spec from "../../../../src/pw/commands/eval/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("function detection", () => {
	test.each([
		"() => 1",
		"el => el.id",
		"(el) => el.id",
		"async () => 1",
		"async el => 1",
		"function () { return 1 }",
		"  () => 1",
	])("treats %p as a function", (source) =>
		expect(isFunctionLike(source)).toBe(true),
	);

	test.each([
		"document.title",
		"1 + 1",
		"window.location.href",
		"[...document.links].length",
		"x == y ? 1 : 2",
	])("treats %p as an expression", (source) =>
		expect(isFunctionLike(source)).toBe(false),
	);
});

describe("toEvaluable", () => {
	test("keeps an expression as a string", () => {
		expect(toEvaluable("document.title")).toBe("document.title");
	});

	test("wraps a function source so the page receives that exact text and nothing runs here", () => {
		const evaluable = toEvaluable("el => el.id, process.exit(1)");
		expect(typeof evaluable).toBe("function");
		expect(String(evaluable)).toBe("el => el.id, process.exit(1)");
	});
});

describe("eval handler", () => {
	test("evaluates an expression on the page and prints JSON", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.evaluated = "Example Domain";
		const result = await handler(ctx, argsFor(spec, "document.title"));
		expect(page.calls).toEqual(["evaluate document.title"]);
		expect(result.result).toBe('"Example Domain"');
		expect(result.snapshot).toBeUndefined();
	});

	test("evaluates a function on an element", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "el => el.value", "e6"));
		expect(page.locator("aria-ref=e6").calls).toEqual([
			"evaluate el => el.value",
		]);
		expect(result.result).toBe("undefined");
	});

	test("writes the result to a file relative to the output directory", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.evaluated = { a: 1 };
		const result = await handler(
			ctx,
			argsFor(spec, "({a: 1})", "--filename=out.json"),
		);
		const file = path.join(scratch.dir, "out.json");
		expect(result.result).toBe(`- [Result](${file})`);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1 });
	});

	test("fails with the fixed message when the element ref is gone", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.missing("aria-ref=e6");
		await expect(handler(ctx, argsFor(spec, "el => 1", "e6"))).rejects.toThrow(
			"Ref not found: e6",
		);
	});
});

describe("eval output permissions", () => {
	test("writes --filename output as 0600", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "({a: 1})", "--filename=private.json"));
		expect(statSync(path.join(scratch.dir, "private.json")).mode & 0o777).toBe(
			0o600,
		);
	});
});

describe("eval code", () => {
	test("quotes an expression", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "document.title"));
		expect(result.code).toBe('await page.evaluate("document.title");');
	});

	test("passes a function as source, not a string", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "() => document.title"));
		expect(result.code).toBe("await page.evaluate(() => document.title);");
	});

	test("evaluates on the element locator when a target is given", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "el => el.value", "e6"));
		expect(result.code).toStartWith("await page.");
		expect(result.code).toEndWith(".evaluate(el => el.value);");
		expect(result.code).not.toStartWith("await page.evaluate(");
	});
});
