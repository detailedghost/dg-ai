import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/go-back/run";
import spec from "../../../src/pw/commands/go-back/spec";

const scratch = useTempScratch();

describe("go-back", () => {
	test("calls goBack and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual(['goBack [{"waitUntil":"load"}]']);
		expect(result).toEqual({ code: "await page.goBack();", snapshot: true });
	});
});
