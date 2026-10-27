import { describe, expect, test } from "bun:test";
import { emptyDeclaredFilters } from "../schema";
import {
	keepUntouchedBaseline,
	observeLive,
	removeDeclaredFilters,
	seedDeclaredFromLive,
	upsertDeclaredFilter,
} from "../store";

const sieve = 'require ["fileinto"];\nif true {\n  keep;\n}\n';

function declaredWithDuplicates() {
	const file = emptyDeclaredFilters();
	file.filters = [
		{ name: "Same", enabled: true, sieve: "one", protonId: "a" },
		{ name: "Same", enabled: true, sieve: "two", protonId: "b" },
	];
	return file;
}

describe("declared filter store", () => {
	test("updates the filter with the matching Proton ID when names repeat", () => {
		const file = declaredWithDuplicates();
		upsertDeclaredFilter(file, { name: "Same", enabled: false, sieve: "three", protonId: "b" });
		expect(file.filters[0]).toMatchObject({ sieve: "one", protonId: "a", enabled: true });
		expect(file.filters[1]).toMatchObject({ sieve: "three", protonId: "b", enabled: false });
	});

	test("adds a filter instead of taking over the identity of a same-named one", () => {
		const file = declaredWithDuplicates();
		upsertDeclaredFilter(file, { name: "Same", enabled: true, sieve: "new", protonId: "c" });
		expect(file.filters.map((filter) => filter.protonId)).toEqual(["a", "b", "c"]);
	});

	test("falls back to the name only for a filter without an ID", () => {
		const file = emptyDeclaredFilters();
		file.filters = [{ name: "Same", enabled: true, sieve: "one" }];
		upsertDeclaredFilter(file, { name: "Same", enabled: true, sieve: "two", protonId: "a" });
		expect(file.filters).toHaveLength(1);
		expect(file.filters[0]).toMatchObject({ sieve: "two", protonId: "a" });
	});

	test("updates and removes the staged entry a local id names when names repeat", () => {
		const file = emptyDeclaredFilters();
		file.filters = [
			{ name: "Same", enabled: true, sieve: "one" },
			{ name: "Same", enabled: true, sieve: "two" },
			{ name: "Same", enabled: true, sieve: "three" },
		];
		upsertDeclaredFilter(file, { name: "Same", enabled: true, sieve: "edited" }, "declared:1");
		expect(file.filters.map((filter) => filter.sieve)).toEqual(["one", "edited", "three"]);
		removeDeclaredFilters(file, ["declared:1"]);
		expect(file.filters.map((filter) => filter.sieve)).toEqual(["one", "three"]);
	});

	test("keeps the baseline for filters a plan did not touch", () => {
		const file = emptyDeclaredFilters();
		const entry = (id: string, text: string) => ({ id, name: id, enabled: true, sieve: text });
		const baseline = { filters: [entry("a", "old"), entry("b", "old")], folders: [] };
		file.filters = [];
		observeLive(file, [entry("a", "remote"), entry("b", "pushed"), entry("c", "new")], []);
		keepUntouchedBaseline(file, baseline, new Set(["b"]));
		expect(file.observed?.filters.map((filter) => [filter.id, filter.sieve])).toEqual([
			["a", "old"],
			["b", "pushed"],
		]);
	});

	test("keeps duplicate-name identities when observing live", () => {
		const file = declaredWithDuplicates();
		const live = [
			{ id: "a", name: "Same", enabled: true, sieve: "one" },
			{ id: "b", name: "Same", enabled: true, sieve: "two" },
		];
		observeLive(file, live, []);
		expect(file.filters.map((filter) => filter.protonId)).toEqual(["a", "b"]);
	});

	test("matches unidentified duplicate names to distinct live filters", () => {
		const file = emptyDeclaredFilters();
		file.filters = [
			{ name: "Same", enabled: true, sieve: "one" },
			{ name: "Same", enabled: true, sieve: "two" },
		];
		observeLive(
			file,
			[
				{ id: "a", name: "Same", enabled: true, sieve: "one", sequence: 1 },
				{ id: "b", name: "Same", enabled: true, sieve: "two", sequence: 2 },
			],
			[],
		);
		expect(file.filters.map((filter) => filter.protonId)).toEqual(["a", "b"]);
		expect(file.observed?.filters.map((filter) => filter.sequence)).toEqual([1, 2]);
	});

	test("seeds declarations in Proton sequence order and keeps the sequence", () => {
		const file = seedDeclaredFromLive({
			filters: [
				{ id: "b", name: "Second", enabled: true, sieve, sequence: 2 },
				{ id: "a", name: "First", enabled: true, sieve, sequence: 1 },
			],
			folders: [],
		});
		expect(file.filters.map((filter) => filter.protonId)).toEqual(["a", "b"]);
		expect(file.observed?.filters.map((filter) => [filter.id, filter.sequence])).toEqual([
			["a", 1],
			["b", 2],
		]);
	});
});
