import { describe, expect, test } from "bun:test";
import {
	findDeclaredFilter,
	overlayDeclaredFilters,
	projectDeclaredFilters,
} from "../src/commands/filter-declared";
import { emptyDeclaredFilters } from "../src/features/filter-policy/schema";

function declaredWith(
	filters: Array<{ name: string; protonId?: string }>,
	observed: Array<{ id: string; name: string }> = [],
) {
	return {
		...emptyDeclaredFilters(),
		filters: filters.map((filter) => ({
			...filter,
			enabled: true,
			sieve: `# ${filter.name}`,
		})),
		observed: {
			filters: observed.map((item) => ({ ...item, enabled: true, sieve: "" })),
			folders: [],
		},
	};
}

describe("declared filter lookup", () => {
	test("prefers the protonId match over an earlier name match", () => {
		const declared = declaredWith([
			{ name: "Receipts" },
			{ name: "Renamed", protonId: "p1" },
		]);
		expect(findDeclaredFilter(declared, { id: "p1", name: "Receipts" })?.name).toBe(
			"Renamed",
		);
	});

	test("falls back to the name only for entries without a protonId", () => {
		const declared = declaredWith([
			{ name: "Receipts", protonId: "p9" },
			{ name: "Receipts" },
		]);
		expect(findDeclaredFilter(declared, { id: "p1", name: "Receipts" })).toBe(
			declared.filters[1],
		);
		expect(
			findDeclaredFilter(declaredWith([{ name: "Receipts", protonId: "p9" }]), {
				id: "p1",
				name: "Receipts",
			}),
		).toBeUndefined();
	});

	test("keeps a live filter whose name matches a removed observed filter with another id", () => {
		const declared = declaredWith([], [{ id: "old", name: "Receipts" }]);
		const live = [{ id: "new", name: "Receipts", enabled: true }];
		expect(overlayDeclaredFilters(live as never, declared)).toHaveLength(1);
		expect(
			overlayDeclaredFilters(
				[{ id: "old", name: "Other", enabled: true }] as never,
				declared,
			),
		).toHaveLength(0);
	});
});

describe("declared filter projection", () => {
	test("includes declared-only filters with local identities", () => {
		const declared = declaredWith([
			{ name: "Receipts", protonId: "p1" },
			{ name: "Staged" },
		]);
		const live = [{ id: "p1", name: "Receipts", enabled: true, conditions: [], actions: [] }];
		const projected = projectDeclaredFilters(live, declared);
		expect(projected.map((filter) => filter.id)).toEqual(["p1", "declared:Staged"]);
	});

	test("leaves out declared entries whose Proton filter is gone", () => {
		const declared = declaredWith([
			{ name: "Receipts", protonId: "p1" },
			{ name: "Deleted", protonId: "p2" },
		]);
		const live = [{ id: "p1", name: "Receipts", enabled: true, conditions: [], actions: [] }];
		const projected = projectDeclaredFilters(live, declared);
		expect(projected.map((filter) => filter.id)).toEqual(["p1"]);
	});
});

