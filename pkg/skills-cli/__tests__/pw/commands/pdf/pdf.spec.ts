import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import path from "node:path";
import handler from "../../../../src/pw/commands/pdf/run";
import spec from "../../../../src/pw/commands/pdf/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("pdf", () => {
	test("writes to a timestamped file in the output directory by default", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		const [call] = page.calls;
		expect(call).toStartWith(`pdf [{"path":"${scratch.dir}/page-`);
		expect(result.result).toMatch(/^- \[Page as PDF\]\(.+page-.+\.pdf\)$/);
	});

	test("resolves a relative filename against the output directory and keeps an absolute one", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "--filename=a.pdf"));
		await handler(ctx, argsFor(spec, `--filename=${path.join(scratch.dir, "abs", "b.pdf")}`));
		expect(page.calls).toEqual([
			`pdf [{"path":"${path.join(scratch.dir, "a.pdf")}"}]`,
			`pdf [{"path":"${path.join(scratch.dir, "abs", "b.pdf")}"}]`,
		]);
	});
});

describe("pdf permissions", () => {
	test("restricts the written file to 0600", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "--filename=private.pdf"));
		expect(statSync(path.join(scratch.dir, "private.pdf")).mode & 0o777).toBe(0o600);
	});
});
