import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/reload/run";
import spec from "../../../../src/pw/commands/reload/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("reload", () => {
	test("calls reload and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual(['reload [{"waitUntil":"load"}]']);
		expect(result).toEqual({ code: "await page.reload();", snapshot: true });
	});
});
