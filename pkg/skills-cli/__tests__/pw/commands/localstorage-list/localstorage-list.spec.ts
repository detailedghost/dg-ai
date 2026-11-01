import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/localstorage-list/run";
import spec from "../../../../src/pw/commands/localstorage-list/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("localstorage-list", () => {
	test("prints each key and value", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.evaluated = [
			["theme", "dark"],
			["lang", "en"],
		];
		const result = await handler(ctx, argsFor(spec));
		expect(page.evaluateArgs).toEqual(["localStorage"]);
		expect(result.result).toBe("theme: dark\nlang: en");
	});

	test("says so when the storage is empty", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.evaluated = [];
		expect((await handler(ctx, argsFor(spec))).result).toBe(
			"No localStorage items found",
		);
	});
});
