import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/route-list/run";
import spec from "../../../../src/pw/commands/route-list/spec";
import { buildRoute } from "../../../../src/pw/core/routes";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("route-list", () => {
	test("says so when no route is active", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		expect((await handler(ctx, argsFor(spec))).result).toBe("No active routes");
	});

	test("numbers each route and shows its mock details", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		ctx.state.routes.push(
			buildRoute({
				pattern: "**/a",
				status: "404",
				body: "x".repeat(60),
				contentType: "text/plain",
			}),
			buildRoute({ pattern: "**/b", header: "X-A: 1", removeHeader: "cookie" }),
			buildRoute({ pattern: "**/c" }),
		);
		const lines = ((await handler(ctx, argsFor(spec))).result as string).split(
			"\n",
		);
		expect(lines[0]).toBe(
			`1. **/a (status=404, body=${"x".repeat(50)}..., contentType=text/plain)`,
		);
		expect(lines[1]).toBe(
			'2. **/b (addHeaders={"x-a":"1"}, removeHeaders=cookie)',
		);
		expect(lines[2]).toBe("3. **/c");
	});
});
