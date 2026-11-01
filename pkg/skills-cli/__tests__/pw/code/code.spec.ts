import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import handler, { toRunnable } from "../../../src/pw/code/run";
import spec from "../../../src/pw/code/spec";
import { COMMANDS } from "../../../src/pw/commands/index";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";

const scratch = useTempScratch();

describe("toRunnable", () => {
	test("invokes the function with the page and tolerates a trailing semicolon", async () => {
		expect(
			await toRunnable("async (page) => page.url();")({
				url: () => "u",
			} as never),
		).toBe("u");
	});

	test("explains code that is not valid JavaScript", () => {
		expect(() => toRunnable("async (page) => {")).toThrow("Invalid code:");
	});

	test("fails when the code is not a function", async () => {
		await expect(Promise.resolve().then(() => toRunnable("42")({} as never))).rejects.toThrow();
	});
});

describe("run-code", () => {
	test("returns the JSON value under Result and asks for a snapshot", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "async (page) => ({ url: page.url() })"));
		expect(result.result).toBe(JSON.stringify({ url: "https://example.test/" }, null, 2));
		expect(result.snapshot).toBe(true);
	});

	test("omits Result when the function returns nothing", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "async (page) => { await page.goto('x'); }"));
		expect(result.result).toBeUndefined();
	});

	test("loads the code from a file relative to the client directory", async () => {
		writeFileSync(path.join(scratch.dir, "snippet.js"), "async (page) => page.title()");
		const { ctx } = fakeCtx(scratch.dir);
		ctx.clientCwd = scratch.dir;
		const result = await handler(ctx, argsFor(spec, "--filename=snippet.js"));
		expect(result.result).toBe('"Example"');
	});

	test("requires code or a filename", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec))).rejects.toThrow("Provide the code");
	});

	test("reports a missing file by path", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		ctx.clientCwd = scratch.dir;
		await expect(handler(ctx, argsFor(spec, "--filename=nope.js"))).rejects.toThrow(
			`File not found: ${path.join(scratch.dir, "nope.js")}`,
		);
	});
});

describe("run-code placement", () => {
	test("is not one of the pw commands, so pw cannot dispatch it", () => {
		expect(COMMANDS.map((entry) => entry.spec.name)).not.toContain(spec.name);
	});
});
