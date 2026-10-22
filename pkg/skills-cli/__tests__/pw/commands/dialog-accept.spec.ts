import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/dialog-accept/run";
import spec from "../../../src/pw/commands/dialog-accept/spec";

const scratch = useTempScratch();

describe("dialog-accept", () => {
	test("accepts the pending dialog with the prompt text", async () => {
		const calls: string[] = [];
		const dialog = { accept: async (text?: string) => void calls.push(`accept ${text}`) };
		const { ctx } = fakeCtx(scratch.dir, undefined, { takeDialog: () => dialog as never });
		const result = await handler(ctx, argsFor(spec, "yes"));
		expect(calls).toEqual(["accept yes"]);
		expect(result).toEqual({ code: 'await dialog.accept("yes");', snapshot: true });
	});

	test("accepts without prompt text", async () => {
		const calls: string[] = [];
		const dialog = { accept: async (text?: string) => void calls.push(`accept ${text}`) };
		const { ctx } = fakeCtx(scratch.dir, undefined, { takeDialog: () => dialog as never });
		const result = await handler(ctx, argsFor(spec));
		expect(calls).toEqual(["accept undefined"]);
		expect(result.code).toBe("await dialog.accept();");
	});

	test("fails when no dialog is pending", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec))).rejects.toThrow("No dialog visible");
	});
});
