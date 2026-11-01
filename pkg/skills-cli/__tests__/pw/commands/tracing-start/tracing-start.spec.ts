import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/tracing-start/run";
import spec from "../../../../src/pw/commands/tracing-start/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("tracing-start", () => {
	test("starts tracing with screenshots and snapshots", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual([
			'tracing.start [{"screenshots":true,"snapshots":true}]',
		]);
		expect(ctx.state.tracing).toBe(true);
		expect(result.result).toBe("Trace recording started");
	});

	test("refuses to start twice", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		ctx.state.tracing = true;
		await expect(handler(ctx, argsFor(spec))).rejects.toThrow(
			"Tracing is already started",
		);
	});
});
