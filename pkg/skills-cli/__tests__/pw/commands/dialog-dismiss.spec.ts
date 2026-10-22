import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/dialog-dismiss/run";
import spec from "../../../src/pw/commands/dialog-dismiss/spec";

const scratch = useTempScratch();

describe("dialog-dismiss", () => {
	test("dismisses the pending dialog", async () => {
		const calls: string[] = [];
		const dialog = { dismiss: async () => void calls.push("dismiss") };
		const { ctx } = fakeCtx(scratch.dir, undefined, { takeDialog: () => dialog as never });
		const result = await handler(ctx, argsFor(spec));
		expect(calls).toEqual(["dismiss"]);
		expect(result).toEqual({ code: "await dialog.dismiss();", snapshot: true });
	});

	test("fails when no dialog is pending", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec))).rejects.toThrow("No dialog visible");
	});
});
