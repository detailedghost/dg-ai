import { describe, expect, test } from "bun:test";
import handler, { parseLevel } from "../../../../src/pw/commands/console/run";
import spec from "../../../../src/pw/commands/console/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

const entries = [
	{ type: "log", text: "hello" },
	{ type: "warning", text: "careful" },
	{ type: "error", text: "boom" },
	{ type: "debug", text: "trace" },
];

describe("parseLevel", () => {
	test("defaults to info and rejects unknown levels with a usage error", () => {
		expect(parseLevel(undefined)).toBe("info");
		expect(parseLevel("debug")).toBe("debug");
		expect(() => parseLevel("loud")).toThrow("Invalid level 'loud'");
	});
});

describe("console", () => {
	test("lists info and more severe messages with the totals header", async () => {
		const { ctx } = fakeCtx(scratch.dir, undefined, { console: () => entries });
		const result = await handler(ctx, argsFor(spec));
		expect(result.result).toBe(
			'Total messages: 4 (Errors: 1, Warnings: 1)\nReturning 3 messages for level "info"\n\n[LOG] hello\n[WARNING] careful\n[ERROR] boom',
		);
	});

	test("warning returns only warning and error entries", async () => {
		const { ctx } = fakeCtx(scratch.dir, undefined, { console: () => entries });
		const result = await handler(ctx, argsFor(spec, "warning"));
		expect(result.result).toContain("[WARNING] careful\n[ERROR] boom");
		expect(result.result).not.toContain("hello");
	});

	test("debug returns everything without the Returning line", async () => {
		const { ctx } = fakeCtx(scratch.dir, undefined, { console: () => entries });
		const result = await handler(ctx, argsFor(spec, "debug"));
		expect(result.result).not.toContain("Returning");
		expect(result.result).toContain("[DEBUG] trace");
	});

	test("--clear empties the buffer after listing", async () => {
		let cleared = 0;
		const { ctx } = fakeCtx(scratch.dir, undefined, {
			console: () => entries,
			clearConsole: () => void cleared++,
		});
		await handler(ctx, argsFor(spec));
		expect(cleared).toBe(0);
		await handler(ctx, argsFor(spec, "--clear"));
		expect(cleared).toBe(1);
	});
});
