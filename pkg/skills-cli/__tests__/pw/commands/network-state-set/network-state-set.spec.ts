import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/network-state-set/run";
import spec from "../../../../src/pw/commands/network-state-set/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("network-state-set", () => {
	test.each([
		["offline", true],
		["online", false],
	])("%s sets offline to %p", async (state, offline) => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, state));
		expect(page.calls).toEqual([`context.setOffline [${offline}]`]);
		expect(result.result).toBe(`Network is now ${state}`);
	});

	test("rejects another state with a usage error", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "flaky"))).rejects.toThrow("Invalid state 'flaky'");
	});
});
