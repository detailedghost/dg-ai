import { describe, expect, test } from "bun:test";
import handler, {
	renderRequest,
} from "../../../../src/pw/commands/network/run";
import spec from "../../../../src/pw/commands/network/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

type Fake = {
	url: string;
	method?: string;
	type?: string;
	status?: number;
	failure?: string;
	body?: string;
	headers?: Record<string, string>;
};

const fake = (item: Fake) =>
	({
		url: () => item.url,
		method: () => item.method ?? "GET",
		resourceType: () => item.type ?? "document",
		failure: () => (item.failure ? { errorText: item.failure } : null),
		existingResponse: () =>
			item.status
				? { status: () => item.status, statusText: () => "OK" }
				: null,
		postData: () => item.body ?? null,
		headers: () => item.headers ?? {},
	}) as never;

const requests = [
	fake({ url: "https://a.test/", status: 200 }),
	fake({ url: "https://a.test/logo.png", type: "image", status: 200 }),
	fake({
		url: "https://a.test/api/users",
		type: "fetch",
		status: 200,
		method: "post",
		body: "{}",
	}),
	fake({ url: "https://a.test/missing.js", type: "script", status: 404 }),
	fake({
		url: "https://a.test/blocked",
		type: "fetch",
		failure: "net::ERR_BLOCKED",
	}),
];

const run = (...argv: string[]) => {
	let cleared = 0;
	const { ctx } = fakeCtx(scratch.dir, undefined, {
		requests: () => requests,
		clearRequests: () => void cleared++,
	});
	return handler(ctx, argsFor(spec, ...argv)).then((result) => ({
		result: result.result as string,
		cleared: () => cleared,
	}));
};

describe("renderRequest", () => {
	test("shows method, url, and response status", () => {
		expect(renderRequest(requests[2] as never, false, false)).toBe(
			"[POST] https://a.test/api/users => [200] OK",
		);
	});

	test("adds the body and headers on request", () => {
		const request = fake({
			url: "https://a.test/x",
			status: 200,
			body: "b",
			headers: { a: "1" },
		});
		expect(renderRequest(request, true, true)).toBe(
			"[GET] https://a.test/x => [200] OK\n  Request headers:\n    a: 1\n  Request body: b",
		);
	});
});

describe("network", () => {
	test("hides successful static resources by default", async () => {
		const { result } = await run();
		expect(result).toBe(
			[
				"[POST] https://a.test/api/users => [200] OK",
				"[GET] https://a.test/missing.js => [404] OK",
				"[GET] https://a.test/blocked => [FAILED] net::ERR_BLOCKED",
			].join("\n"),
		);
	});

	test("--static lists everything", async () => {
		expect((await run("--static")).result.split("\n")).toHaveLength(5);
	});

	test("--filter returns only matching urls", async () => {
		expect((await run("--static", "--filter=/api/")).result).toBe(
			"[POST] https://a.test/api/users => [200] OK",
		);
	});

	test("rejects an invalid expression with a usage error", async () => {
		await expect(run("--filter=(")).rejects.toThrow("Invalid --filter '('");
	});

	test("says so when nothing matches and clears on request", async () => {
		const outcome = await run("--filter=zzz", "--clear");
		expect(outcome.result).toBe("No network requests");
		expect(outcome.cleared()).toBe(1);
	});
});
