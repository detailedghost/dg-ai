import { describe, expect, test } from "bun:test";
import {
	listReleases,
	RELEASES_PAGE_CAP,
	RELEASES_PER_PAGE,
	type Release,
} from "@dg/skills-cli/lib";

function fillerReleases(count: number, tagPrefix = "ext-v0.0."): Release[] {
	return Array.from({ length: count }, (_, i) => ({
		tag_name: `${tagPrefix}${i}`,
		draft: false,
		assets: [],
	}));
}

async function withStubbedFetch<T>(
	handler: (page: number) => Release[],
	body: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		calls++;
		const url = new URL(input.toString());
		const page = Number(url.searchParams.get("page") ?? "1");
		return new Response(JSON.stringify(handler(page)), { status: 200 });
	}) as typeof fetch;
	try {
		return { result: await body(), calls };
	} finally {
		globalThis.fetch = original;
	}
}

describe("listReleases pages past the first GitHub response", () => {
	test("a short second page ends the scan, with both pages' releases returned", async () => {
		const { result, calls } = await withStubbedFetch(
			(page) =>
				page === 1
					? fillerReleases(RELEASES_PER_PAGE)
					: fillerReleases(5, "daemon-v0.0."),
			() => listReleases(),
		);

		expect(calls).toBe(2);
		expect(result.length).toBe(RELEASES_PER_PAGE + 5);
	});

	test("a lone short first page makes exactly one request", async () => {
		const { calls, result } = await withStubbedFetch(
			() => fillerReleases(3),
			() => listReleases(),
		);

		expect(calls).toBe(1);
		expect(result.length).toBe(3);
	});

	test("full pages forever stop at the page cap rather than looping forever", async () => {
		const { calls, result } = await withStubbedFetch(
			() => fillerReleases(RELEASES_PER_PAGE),
			() => listReleases(),
		);

		expect(calls).toBe(RELEASES_PAGE_CAP);
		expect(result.length).toBe(RELEASES_PER_PAGE * RELEASES_PAGE_CAP);
	});
});
