import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../src/pw/core/args";
import { argsFor, fakeCtx } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/tour-step/run";
import spec from "../../../src/pw/commands/tour-step/spec";

/** `evaluateHandle`'s first arg is a function reference; FakePage's recorder JSON.stringifies the call, which drops it to `null` — only the second (data) argument is inspectable here. */
function evaluateHandleOpts(call: string | undefined): {
	css: string;
	step: Record<string, unknown>;
	target: string | null;
} {
	const match = /^evaluateHandle \[null,(.+)\]$/.exec(call ?? "");
	if (!match) throw new Error(`not an evaluateHandle call: ${call}`);
	return JSON.parse(match[1] as string);
}

describe("tour-step handler", () => {
	test("renders a centered step via evaluateHandle when no --target is given", async () => {
		const { ctx, page } = fakeCtx("/out");
		await handler(
			ctx,
			argsFor(spec, "Click here to persist the current filter set.", "--index=0", "--total=3"),
		);
		expect(page.calls).toHaveLength(1);
		const opts = evaluateHandleOpts(page.calls[0]);
		expect(opts.target).toBeNull();
		expect(opts.css).toContain(":host");
		expect(opts.step).toEqual({
			body: "Click here to persist the current filter set.",
			index: 0,
			total: 3,
			phase: "tutorial",
			video: false,
			hideBody: false,
			actionMissing: false,
			waitingForClick: false,
		});
	});

	test("scrolls --target into view before rendering and reports it in the result", async () => {
		const { ctx, page } = fakeCtx("/out");
		const result = await handler(
			ctx,
			argsFor(spec, "Save a filter", "--target=#save-filter-btn", "--index=0", "--total=3", "--heading=Save a filter"),
		);
		expect(page.locator("#save-filter-btn").calls).toEqual(["scrollIntoViewIfNeeded [{\"timeout\":1500}]"]);
		expect(result.result).toContain("spotlighting #save-filter-btn");
	});

	test("tolerates a --target that never resolves instead of failing the step", async () => {
		const { ctx, page } = fakeCtx("/out");
		const target = "#missing";
		const locator = page.locator(target);
		locator.returns.scrollIntoViewIfNeeded = new Error("timeout");
		await expect(
			handler(ctx, argsFor(spec, "Body", `--target=${target}`, "--index=0", "--total=1")),
		).resolves.toBeDefined();
	});

	test("marks video mode, hidden body, missing-action, and waiting-for-click flags", async () => {
		const { ctx, page } = fakeCtx("/out");
		await handler(
			ctx,
			argsFor(
				spec,
				"Narration",
				"--index=1",
				"--total=2",
				"--video",
				"--hide-body",
				"--action-missing",
				"--waiting-for-click",
				"--script-title=Demo",
				"--phase=setup",
			),
		);
		const opts = evaluateHandleOpts(page.calls[0]);
		expect(opts.step).toMatchObject({
			scriptTitle: "Demo",
			phase: "setup",
			video: true,
			hideBody: true,
			actionMissing: true,
			waitingForClick: true,
		});
	});

	test("rejects a phase other than setup or tutorial", async () => {
		const { ctx } = fakeCtx("/out");
		await expect(
			handler(ctx, argsFor(spec, "Body", "--index=0", "--total=1", "--phase=bogus")),
		).rejects.toThrow(UsageError);
	});

	test("requires --index and --total", async () => {
		const { ctx } = fakeCtx("/out");
		await expect(handler(ctx, argsFor(spec, "Body"))).rejects.toThrow(UsageError);
		await expect(handler(ctx, argsFor(spec, "Body", "--index=0"))).rejects.toThrow(UsageError);
	});
});
