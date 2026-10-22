import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/click/run";
import spec from "../../../src/pw/commands/click/spec";

const scratch = useTempScratch();

describe("click spec", () => {
	test("takes a target, an optional button, and modifiers", () => {
		const args = argsFor(spec, "e5", "right", "--modifiers=Shift");
		expect(args.positionals).toEqual(["e5", "right"]);
		expect(args.flags).toEqual({ modifiers: "Shift" });
	});
});

describe("click handler", () => {
	test("clicks the aria-ref locator and asks for a snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "e5"));
		expect(page.locator("aria-ref=e5").calls).toEqual(['click {"button":"left","modifiers":[]}']);
		expect(result).toEqual({ code: "await page.locator('aria-ref=e5').click();", snapshot: true });
	});

	test("passes the button and modifiers and records them in the generated code", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "#save", "right", "--modifiers=Shift"));
		expect(page.locator("#save").calls).toEqual(['click {"button":"right","modifiers":["Shift"]}']);
		expect(result.code).toBe('await page.locator(\'#save\').click({"button":"right","modifiers":["Shift"]});');
	});

	test("fails with the fixed message when the ref is gone", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.missing("aria-ref=e9");
		await expect(handler(ctx, argsFor(spec, "e9"))).rejects.toThrow("Ref not found: e9. Take a new snapshot.");
	});
});
