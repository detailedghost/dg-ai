import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/cookie-get/run";
import spec from "../../../../src/pw/commands/cookie-get/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("cookie-get", () => {
	test("prints the named cookie with its flags", async () => {
		const { ctx, context } = fakeCtx(scratch.dir);
		context.returns["cookies"] = [
			{
				name: "sid",
				value: "1",
				domain: "a.test",
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
				expires: 5,
			},
		];
		const result = await handler(ctx, argsFor(spec, "sid"));
		expect(result.result).toBe(
			"sid=1 (domain: a.test, path: /, httpOnly: true, secure: true, sameSite: Lax, expires: 5)",
		);
	});

	test("says so when the cookie does not exist", async () => {
		const { ctx, context } = fakeCtx(scratch.dir);
		context.returns["cookies"] = [];
		expect((await handler(ctx, argsFor(spec, "sid"))).result).toBe("Cookie 'sid' not found");
	});
});
