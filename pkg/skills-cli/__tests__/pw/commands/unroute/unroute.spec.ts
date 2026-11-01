import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/unroute/run";
import spec from "../../../../src/pw/commands/unroute/spec";
import { addRoute, buildRoute } from "../../../../src/pw/core/routes";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

async function withRoutes() {
	const made = fakeCtx(scratch.dir);
	await addRoute(made.ctx, buildRoute({ pattern: "**/a" }));
	await addRoute(made.ctx, buildRoute({ pattern: "**/b" }));
	made.page.calls.length = 0;
	return made;
}

describe("unroute", () => {
	test("removes only the routes for the pattern", async () => {
		const { ctx, page } = await withRoutes();
		const result = await handler(ctx, argsFor(spec, "**/a"));
		expect(page.calls).toHaveLength(1);
		expect(page.calls[0]).toStartWith('context.unroute ["**/a"');
		expect(ctx.state.routes.map((entry) => entry.pattern)).toEqual(["**/b"]);
		expect(result.result).toBe("Removed 1 route(s) for pattern: **/a");
	});

	test("removes every route without a pattern", async () => {
		const { ctx } = await withRoutes();
		const result = await handler(ctx, argsFor(spec));
		expect(ctx.state.routes).toEqual([]);
		expect(result.result).toBe("Removed all 2 route(s)");
	});
});
