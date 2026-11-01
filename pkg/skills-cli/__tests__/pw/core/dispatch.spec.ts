import { describe, expect, test } from "bun:test";
import evalSpec from "../../../src/pw/commands/eval/spec";
import goto from "../../../src/pw/commands/goto/spec";
import { UsageError } from "../../../src/pw/core/args";
import {
	type DispatchOptions,
	describeError,
	dispatch,
} from "../../../src/pw/core/dispatch";
import type { DaemonHandler, HandlerResult } from "../../../src/pw/core/spec";
import {
	argsFor,
	fakeCtx,
	fakeEvents,
	useTempScratch,
} from "../../../src/pw/test-support";

const scratch = useTempScratch();

const options = (
	overrides: Partial<DispatchOptions> = {},
): DispatchOptions => ({
	raw: false,
	codegen: false,
	state: {},
	...overrides,
});

const returning =
	(outcome: HandlerResult): DaemonHandler =>
	async () =>
		outcome;

describe("dispatch", () => {
	test("renders page, auto snapshot at depth 6, and exit code 0 for a page-changing command", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const out = await dispatch(
			returning({ snapshot: true }),
			goto,
			argsFor(goto, "a.test"),
			ctx,
			options(),
		);
		expect(out.exitCode).toBe(0);
		expect(out.text).toContain(
			"### Page\n- Page URL: https://example.test/\n- Page Title: Example",
		);
		expect(out.text).toMatch(
			/### Snapshot\n\[Snapshot\]\(.+page-.+\.yml\) 19 B, 1 line/,
		);
		expect(page.snapshotCalls).toEqual([{ mode: "ai", depth: 6 }]);
	});

	test("prints a string result as is and any other result as JSON", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const text = (result: unknown) =>
			dispatch(
				returning({ result }),
				evalSpec,
				argsFor(evalSpec, "x"),
				ctx,
				options(),
			);
		expect((await text("plain")).text).toContain("### Result\nplain");
		expect((await text({ a: 1 })).text).toContain('### Result\n{\n  "a": 1\n}');
	});

	test("shows the page section only when the page header changed", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const state = {};
		const run = () =>
			dispatch(
				returning({ result: "1" }),
				evalSpec,
				argsFor(evalSpec, "x"),
				ctx,
				options({ state }),
			);
		expect((await run()).text).toContain("### Page");
		expect((await run()).text).not.toContain("### Page");
	});

	test("turns a thrown error into an Error section, exit code 1, and no snapshot", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const failing: DaemonHandler = async () => {
			throw new Error("Ref not found: e9. Take a new snapshot.");
		};
		const out = await dispatch(
			failing,
			goto,
			argsFor(goto, "a.test"),
			ctx,
			options(),
		);
		expect(out.exitCode).toBe(1);
		expect(out.text).toStartWith(
			"### Error\nRef not found: e9. Take a new snapshot.",
		);
		expect(out.text).toContain("### Page");
		expect(out.text).not.toContain("### Snapshot");
		expect(page.snapshotCalls).toEqual([]);
	});

	test("an explicit snapshot request honors depth 0 as unlimited", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await dispatch(
			returning({ snapshot: { depth: 0 } }),
			goto,
			argsFor(goto, "a.test"),
			ctx,
			options(),
		);
		expect(page.snapshotCalls).toEqual([{ mode: "ai", depth: 0 }]);
	});

	test("scopes an explicit snapshot to its target and restores the ref map", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const out = await dispatch(
			returning({ snapshot: { target: "e3" } }),
			goto,
			argsFor(goto, "a.test"),
			ctx,
			options(),
		);
		expect(out.text).toContain("[Snapshot](");
		expect(page.snapshotCalls).toEqual([{ mode: "ai", depth: 1 }]);
	});

	test("reports a missing snapshot target as an error", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.missing("aria-ref=e9");
		const out = await dispatch(
			returning({ snapshot: { target: "e9" } }),
			goto,
			argsFor(goto, "a.test"),
			ctx,
			options(),
		);
		expect(out.exitCode).toBe(1);
		expect(out.text).toContain("Ref not found: e9. Take a new snapshot.");
	});

	test("raw hides the auto snapshot but keeps the link of an explicit snapshot", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const auto = await dispatch(
			returning({ result: "v", snapshot: true }),
			goto,
			argsFor(goto, "a.test"),
			ctx,
			options({ raw: true }),
		);
		expect(auto.text).toBe("v");
		const explicit = await dispatch(
			returning({ snapshot: {} }),
			goto,
			argsFor(goto, "a.test"),
			ctx,
			options({ raw: true }),
		);
		expect(explicit.text).toStartWith("[Snapshot](");
	});

	test("shows the generated code only with codegen", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const handler = returning({ code: "await page.goto('x');" });
		expect(
			(await dispatch(handler, goto, argsFor(goto, "a.test"), ctx, options()))
				.text,
		).not.toContain("Ran Playwright code");
		expect(
			(
				await dispatch(
					handler,
					goto,
					argsFor(goto, "a.test"),
					ctx,
					options({ codegen: true }),
				)
			).text,
		).toContain("await page.goto('x');");
	});

	test("lists drained console events", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		ctx.events = fakeEvents({
			drain: () => [{ type: "error", text: "bad" }],
			totals: () => ({ errors: 1, warnings: 0 }),
		});
		const out = await dispatch(
			returning({ result: "1" }),
			evalSpec,
			argsFor(evalSpec, "x"),
			ctx,
			options(),
		);
		expect(out.text).toContain(
			"### Events\n- Console: 1 new (1 error)\n  - [error] bad",
		);
		expect(out.text).toContain("- Console: 1 errors, 0 warnings");
	});
});

describe("dispatch depth and modal state", () => {
	const depthOf = async (
		options: Partial<DispatchOptions>,
		snapshot: HandlerResult["snapshot"] = true,
	) => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await dispatch(
			returning({ snapshot }),
			goto,
			argsFor(goto, "a.test"),
			ctx,
			{
				raw: false,
				codegen: false,
				state: {},
				...options,
			},
		);
		return (page.snapshotCalls[0] as { depth: number }).depth;
	};

	test("defaults to 6, then env, then the session value", async () => {
		expect(await depthOf({})).toBe(6);
		expect(await depthOf({ envDepth: 3 })).toBe(3);
		expect(await depthOf({ envDepth: 3, sessionDepth: 9 })).toBe(9);
	});

	test("a per-call depth beats the session and env values, and 0 stays unlimited", async () => {
		expect(await depthOf({ envDepth: 3, sessionDepth: 9 }, { depth: 2 })).toBe(
			2,
		);
		expect(await depthOf({ sessionDepth: 9 }, { depth: 0 })).toBe(0);
	});

	test("lets a usage error from a handler reach the caller as exit code 2", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const failing: DaemonHandler = async () => {
			throw new UsageError("Invalid --status 'x'");
		};
		await expect(
			dispatch(failing, goto, argsFor(goto, "a.test"), ctx, options()),
		).rejects.toBeInstanceOf(UsageError);
	});

	test("prints downloads under Events and pending dialogs or choosers under Modal state", async () => {
		const { ctx } = fakeCtx(scratch.dir, undefined, {
			drainNotices: () => ["- Downloaded a.csv to /tmp/a.csv"],
			modal: () => ['- [File chooser]: can be handled by the "upload" command'],
		});
		const out = await dispatch(
			returning({ result: "1" }),
			evalSpec,
			argsFor(evalSpec, "x"),
			ctx,
			options(),
		);
		expect(out.text).toContain("### Events\n- Downloaded a.csv to /tmp/a.csv");
		expect(out.text).toEndWith(
			'### Modal state\n- [File chooser]: can be handled by the "upload" command',
		);
	});

	test("returns at once with the modal state when a dialog opens during the action", async () => {
		let open: () => void = () => undefined;
		let pending = false;
		const { ctx, page } = fakeCtx(scratch.dir, undefined, {
			hasDialog: () => pending,
			modal: () =>
				pending
					? [
							'- ["alert" dialog with message "Hi"]: can be handled by the "dialog-accept" or "dialog-dismiss" command',
						]
					: [],
			watchDialog: () => ({
				opened: new Promise<void>((resolve) => {
					open = resolve;
				}),
				dispose: () => undefined,
			}),
		});
		const hanging: DaemonHandler = () => new Promise(() => undefined);
		const running = dispatch(
			hanging,
			goto,
			argsFor(goto, "a.test"),
			ctx,
			options(),
		);
		pending = true;
		open();
		const out = await running;
		expect(out.exitCode).toBe(0);
		expect(out.text).toBe(
			'### Modal state\n- ["alert" dialog with message "Hi"]: can be handled by the "dialog-accept" or "dialog-dismiss" command',
		);
		expect(page.snapshotCalls).toEqual([]);
	});
});

describe("describeError", () => {
	test("turns a missing Playwright binary into an install hint", () => {
		const message =
			"Executable doesn't exist at /h/.cache/ms-playwright/firefox-1509/firefox/firefox\n╔═╗";
		expect(describeError(new Error(message))).toBe(
			"Playwright firefox is not installed. run: bunx playwright-core install firefox",
		);
	});

	test("strips terminal colors and keeps only the first 12 lines", () => {
		const message = [
			"\u001b[31mfirst\u001b[39m",
			...Array.from({ length: 20 }, (_, i) => `line ${i}`),
		].join("\n");
		const lines = describeError(new Error(message)).split("\n");
		expect(lines).toHaveLength(12);
		expect(lines[0]).toBe("first");
	});

	test("shortens very long lines", () => {
		expect(describeError(new Error("x".repeat(1000))).length).toBeLessThan(310);
	});

	test("accepts a non-error value", () => {
		expect(describeError("oops")).toBe("oops");
	});
});
