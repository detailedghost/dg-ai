import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/go-forward/run";
import spec from "../../../src/pw/commands/go-forward/spec";

const scratch = useTempScratch();

describe("go-forward", () => {
	test("calls goForward and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual(['goForward [{"waitUntil":"load"}]']);
		expect(result).toEqual({ code: "await page.goForward();", snapshot: true });
	});
});
