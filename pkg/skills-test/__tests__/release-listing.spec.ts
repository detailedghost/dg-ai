import { describe, expect, test } from "bun:test";
import {
	describeMissingCliAsset,
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

describe("describeMissingCliAsset tells apart the two ways a binary can be unavailable", () => {
	const SPEC = { binaryName: "dg-daemon", tagPrefix: "daemon-v" };

	test("a matching release exists, just not for this platform", () => {
		const releases: Release[] = [
			{ tag_name: "daemon-v1.0.0", draft: false, assets: [] },
		];
		expect(describeMissingCliAsset(SPEC, releases)).toEqual({
			kind: "no-platform-asset",
		});
	});

	test("no release with the tag prefix appears anywhere in the scanned set", () => {
		const releases: Release[] = [
			{ tag_name: "ext-v1.0.0", draft: false, assets: [] },
			{ tag_name: "skills-v1.0.0", draft: false, assets: [] },
		];
		expect(describeMissingCliAsset(SPEC, releases)).toEqual({
			kind: "no-matching-release",
			releasesScanned: 2,
		});
	});

	test("a draft release with the right prefix does not count as a match", () => {
		const releases: Release[] = [
			{ tag_name: "daemon-v9.9.9", draft: true, assets: [] },
		];
		expect(describeMissingCliAsset(SPEC, releases)).toEqual({
			kind: "no-matching-release",
			releasesScanned: 1,
		});
	});
});
