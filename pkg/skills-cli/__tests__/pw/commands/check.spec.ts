import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/check/run";
import spec from "../../../src/pw/commands/check/spec";

const scratch = useTempScratch();

describe("check", () => {
	test("checks the target and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "#agree"));
		expect(page.locator("#agree").calls).toEqual(["check []"]);
		expect(result).toEqual({ code: "await page.locator('#agree').check();", snapshot: true });
	});
});
