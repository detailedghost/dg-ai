import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/cookie-set/run";
import spec from "../../../../src/pw/commands/cookie-set/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("cookie-set", () => {
	test("defaults the domain to the page host and the path to /", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "sid", "abc"));
		expect(page.calls).toEqual([
			'context.addCookies [[{"name":"sid","value":"abc","domain":"example.test","path":"/","expires":-1,"httpOnly":false,"secure":false,"sameSite":"Lax"}]]',
		]);
	});

	test("applies every flag", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await handler(
			ctx,
			argsFor(
				spec,
				"sid",
				"abc",
				"--domain=a.test",
				"--path=/x",
				"--expires=99",
				"--httpOnly",
				"--secure",
				"--sameSite=None",
			),
		);
		expect(page.calls[0]).toContain(
			'"domain":"a.test","path":"/x","expires":99,"httpOnly":true,"secure":true,"sameSite":"None"',
		);
	});

	test("rejects an unparsable expiry or SameSite value with a usage error", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "a", "b", "--expires=soon"))).rejects.toThrow("Invalid --expires 'soon'");
		await expect(handler(ctx, argsFor(spec, "a", "b", "--sameSite=Wide"))).rejects.toThrow("Invalid --sameSite 'Wide'");
	});
});
