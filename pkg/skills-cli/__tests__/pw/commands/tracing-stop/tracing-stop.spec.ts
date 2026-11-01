import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import handler from "../../../../src/pw/commands/tracing-stop/run";
import spec from "../../../../src/pw/commands/tracing-stop/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("tracing-stop", () => {
	test("saves the trace to a timestamped zip in the output directory", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		ctx.state.tracing = true;
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls[0]).toStartWith(`tracing.stop [{"path":"${scratch.dir}/`);
		expect(ctx.state.tracing).toBe(false);
		expect(result.result).toMatch(/^- \[Trace\]\(.+trace-.+\.zip\)$/);
	});

	test("fails when tracing was not started", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec))).rejects.toThrow(
			"Tracing is not started",
		);
	});
});

describe("tracing-stop permissions", () => {
	test("restricts the trace to 0600", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		ctx.state.tracing = true;
		await handler(ctx, argsFor(spec));
		const [trace] = readdirSync(scratch.dir).filter((name) =>
			name.endsWith(".zip"),
		);
		expect(statSync(path.join(scratch.dir, trace as string)).mode & 0o777).toBe(
			0o600,
		);
	});
});
