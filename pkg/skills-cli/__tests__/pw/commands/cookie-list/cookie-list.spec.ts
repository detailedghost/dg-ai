import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/cookie-list/run";
import spec from "../../../../src/pw/commands/cookie-list/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

const cookies = [
	{ name: "a", value: "1", domain: ".x.test", path: "/" },
	{ name: "b", value: "2", domain: "y.test", path: "/api" },
];

describe("cookie-list", () => {
	test("lists every cookie", async () => {
		const { ctx, context } = fakeCtx(scratch.dir);
		context.returns["cookies"] = cookies;
		const result = await handler(ctx, argsFor(spec));
		expect(result.result).toBe(
			"a=1 (domain: .x.test, path: /)\nb=2 (domain: y.test, path: /api)",
		);
	});

	test("filters by domain and path", async () => {
		const { ctx, context } = fakeCtx(scratch.dir);
		context.returns["cookies"] = cookies;
		expect((await handler(ctx, argsFor(spec, "--domain=x.test"))).result).toBe(
			"a=1 (domain: .x.test, path: /)",
		);
		expect((await handler(ctx, argsFor(spec, "--path=/api"))).result).toBe(
			"b=2 (domain: y.test, path: /api)",
		);
	});

	test("says so when nothing matches", async () => {
		const { ctx, context } = fakeCtx(scratch.dir);
		context.returns["cookies"] = [];
		expect((await handler(ctx, argsFor(spec))).result).toBe("No cookies found");
	});
});
