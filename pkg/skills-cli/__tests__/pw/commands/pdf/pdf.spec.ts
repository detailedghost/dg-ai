import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import handler from "../../../../src/pw/commands/pdf/run";
import spec from "../../../../src/pw/commands/pdf/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("pdf", () => {
	test("writes to a timestamped file in the output directory by default", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		const [call] = page.calls;
		expect(call).toStartWith(`pdf [{"path":"${scratch.dir}/`);
		expect(result.result).toMatch(/^- \[Page as PDF\]\(.+page-.+\.pdf\)$/);
	});

	test("resolves a relative filename against the output directory and keeps an absolute one", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "--filename=a.pdf"));
		await handler(
			ctx,
			argsFor(spec, `--filename=${path.join(scratch.dir, "abs", "b.pdf")}`),
		);
		expect(existsSync(path.join(scratch.dir, "a.pdf"))).toBe(true);
		expect(existsSync(path.join(scratch.dir, "abs", "b.pdf"))).toBe(true);
		expect(
			page.calls.map(
				(call) => call.endsWith('a.pdf"}]') || call.endsWith('b.pdf"}]'),
			),
		).toEqual([true, true]);
	});
});

describe("pdf permissions", () => {
	test("never writes into an existing shared file", async () => {
		const target = path.join(scratch.dir, "shared", "s.pdf");
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, "old");
		chmodSync(target, 0o644);
		linkSync(target, path.join(scratch.dir, "shared", "seen.pdf"));
		const { ctx } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, `--filename=${target}`));
		expect(
			readFileSync(path.join(scratch.dir, "shared", "seen.pdf"), "utf8"),
		).toBe("old");
		expect(readFileSync(target, "utf8")).toBe("x");
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	test("restricts the written file to 0600", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "--filename=private.pdf"));
		expect(statSync(path.join(scratch.dir, "private.pdf")).mode & 0o777).toBe(
			0o600,
		);
	});
});
