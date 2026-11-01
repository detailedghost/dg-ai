import { describe, expect, test } from "bun:test";
import handler, { parseDepth } from "../../../../src/pw/commands/snapshot/run";
import spec from "../../../../src/pw/commands/snapshot/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();
const run = (...argv: string[]) =>
	handler(fakeCtx(scratch.dir).ctx, argsFor(spec, ...argv));

describe("snapshot spec", () => {
	test("takes an optional element and the filename, depth, and full flags", () => {
		const args = argsFor(spec, "e5", "--filename=a.yml", "--depth=2", "--full");
		expect(args.positionals).toEqual(["e5"]);
		expect(args.flags).toEqual({ filename: "a.yml", depth: "2", full: true });
	});
});

describe("parseDepth", () => {
	test("accepts non-negative integers", () => {
		expect(parseDepth("0")).toBe(0);
		expect(parseDepth("12")).toBe(12);
	});

	test.each(["-1", "2.5", "deep", ""])("rejects %p", (value) => {
		expect(() => parseDepth(value)).toThrow("Invalid --depth");
	});
});

describe("snapshot handler", () => {
	test("leaves the depth to the default when no flag is given", async () => {
		expect(await run()).toEqual({
			snapshot: { target: undefined, depth: undefined, filename: undefined },
		});
	});

	test("passes a scoped target and filename through", async () => {
		expect(await run("#main", "--filename=part.yml")).toEqual({
			snapshot: { target: "#main", depth: undefined, filename: "part.yml" },
		});
	});

	test("--depth sets the depth and --full overrides it with unlimited", async () => {
		expect(await run("--depth=2")).toMatchObject({ snapshot: { depth: 2 } });
		expect(await run("--depth=2", "--full")).toMatchObject({
			snapshot: { depth: 0 },
		});
	});

	test("rejects an invalid depth", async () => {
		await expect(run("--depth=abc")).rejects.toThrow("Invalid --depth 'abc'");
	});
});
