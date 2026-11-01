import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/route/run";
import spec from "../../../../src/pw/commands/route/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

function fakeRoute(headers: Record<string, string> = {}) {
	const calls: string[] = [];
	return {
		calls,
		request: () => ({ headers: () => headers }),
		fulfill: async (options: unknown) =>
			void calls.push(`fulfill ${JSON.stringify(options)}`),
		continue: async (options: unknown) =>
			void calls.push(`continue ${JSON.stringify(options)}`),
	};
}

async function register(...argv: string[]) {
	const { ctx, page } = fakeCtx(scratch.dir);
	const result = await handler(ctx, argsFor(spec, ...argv));
	return { ctx, page, result, entry: ctx.state.routes[0] };
}

describe("route", () => {
	test("registers the route on the context and remembers it", async () => {
		const { page, result, entry } = await register(
			"**/api/users",
			"--status=404",
		);
		expect(page.calls[0]).toStartWith('context.route ["**/api/users"');
		expect(entry?.pattern).toBe("**/api/users");
		expect(result.result).toBe("Route added for pattern: **/api/users");
	});

	test("rejects an unparsable status with a usage error", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(
			handler(ctx, argsFor(spec, "**/x", "--status=abc")),
		).rejects.toThrow("Invalid --status 'abc'");
		await expect(
			handler(ctx, argsFor(spec, "**/x", "--status=99")),
		).rejects.toThrow("Invalid --status '99'");
	});

	test("fulfills with the mock when a body or status is given", async () => {
		const { entry } = await register(
			"**/x",
			"--status=201",
			'--body={"a":1}',
			"--content-type=application/json",
		);
		const route = fakeRoute();
		await entry?.handler(route as never);
		expect(route.calls).toEqual([
			'fulfill {"status":201,"contentType":"application/json","body":"{\\"a\\":1}"}',
		]);
	});

	test("continues with added and removed request headers otherwise", async () => {
		const { entry } = await register(
			"**/x",
			"--header=X-A: 1",
			"--header=X-B: 2",
			"--remove-header=Cookie, x-old",
		);
		const route = fakeRoute({ cookie: "c", "x-old": "o", accept: "*/*" });
		await entry?.handler(route as never);
		expect(route.calls).toEqual([
			'continue {"headers":{"accept":"*/*","x-a":"1","x-b":"2"}}',
		]);
	});

	test("rejects a header without a colon", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(
			handler(ctx, argsFor(spec, "**/x", "--header=oops")),
		).rejects.toThrow("Invalid --header 'oops'");
	});
});

describe("route headers and code", () => {
	test("replaces a request header whatever its casing", async () => {
		const { entry } = await register(
			"**/x",
			"--header=Authorization: new",
			"--remove-header=X-Old",
		);
		const route = fakeRoute({ authorization: "old", "x-old": "o" });
		await entry?.handler(route as never);
		expect(route.calls).toEqual([
			'continue {"headers":{"authorization":"new"}}',
		]);
	});

	test("fulfills a mock with the added headers", async () => {
		const { entry } = await register("**/x", "--body=ok", "--header=X-A: 1");
		const route = fakeRoute();
		await entry?.handler(route as never);
		expect(route.calls).toEqual([
			'fulfill {"status":200,"headers":{"x-a":"1"},"body":"ok"}',
		]);
	});

	test("prints a fulfill handler for a mock", async () => {
		const { result } = await register("**/x", "--status=404");
		expect(result.code).toBe(
			'await page.context().route("**/x", (route) => route.fulfill({"status":404}));',
		);
	});

	test("prints a continue handler with the header changes", async () => {
		const { result } = await register(
			"**/x",
			"--header=X-A: 1",
			"--remove-header=Cookie",
		);
		expect(result.code).toBe(
			[
				'await page.context().route("**/x", (route) => {',
				'\tconst headers = { ...route.request().headers(), ...{"x-a":"1"} };',
				'\tdelete headers["cookie"];',
				"\treturn route.continue({ headers });",
				"});",
			].join("\n"),
		);
	});
});
