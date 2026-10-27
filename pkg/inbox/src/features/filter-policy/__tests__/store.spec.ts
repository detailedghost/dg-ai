import { describe, expect, test } from "bun:test";
import { emptyDeclaredFilters } from "../schema";
import {
	keepUntouchedBaseline,
	observeLive,
	removeDeclaredFilters,
	seedDeclaredFromLive,
	upsertDeclaredFilter,
	upsertDeclaredFolder,
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
	test("updates the folder with the matching Proton ID when an earlier folder shares the path", () => {
		const file = emptyDeclaredFilters();
		file.folders = [
			{ path: "Same", type: "folder", protonId: "a" },
			{ path: "Same", type: "folder", protonId: "b" },
		];
		upsertDeclaredFolder(file, { path: "Same", type: "label", protonId: "b" });
		expect(file.folders[0]).toMatchObject({ type: "folder", protonId: "a" });
		expect(file.folders[1]).toMatchObject({ type: "label", protonId: "b" });
	});

	test("matches a folder by path only when it has no ID and the path is unambiguous", () => {
		const file = emptyDeclaredFilters();
		file.folders = [
			{ path: "Same", type: "folder", protonId: "a" },
			{ path: "Open", type: "folder" },
		];
		upsertDeclaredFolder(file, { path: "Same", type: "label", protonId: "b" });
		upsertDeclaredFolder(file, { path: "Open", type: "label", protonId: "c" });
		expect(file.folders.map((folder) => folder.protonId)).toEqual(["a", "c", "b"]);
	});

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

	test("advances the sequence of pulled-order filters and keeps their content baseline", () => {
		const file = emptyDeclaredFilters();
		const entry = (id: string, text: string, sequence: number) => ({
			id,
			name: id,
			enabled: true,
			sieve: text,
			sequence,
		});
		const baseline = { filters: [entry("a", "old", 1), entry("b", "old", 2)], folders: [] };
		file.filters = [];
		observeLive(file, [entry("b", "old", 1), entry("a", "remote", 2)], []);
		keepUntouchedBaseline(file, baseline, new Set(), new Set(["a", "b"]));
		expect(
			file.observed?.filters.map((filter) => [filter.id, filter.sieve, filter.sequence]),
		).toEqual([
			["b", "old", 1],
			["a", "old", 2],
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

	test("keeps a declaration's ID when a same-named replacement appears", () => {
		const file = emptyDeclaredFilters();
		file.filters = [{ name: "Same", enabled: true, sieve: "one", protonId: "gone" }];
		observeLive(file, [{ id: "new", name: "Same", enabled: true, sieve: "two" }], [], {
			filters: ["Same"],
			folders: [],
		});
		expect(file.filters[0]?.protonId).toBe("gone");
	});

	test("assigns an ID only to a declaration created in this run and matched uniquely", () => {
		const file = emptyDeclaredFilters();
		file.filters = [
			{ name: "Fresh", enabled: true, sieve: "one" },
			{ name: "Staged", enabled: true, sieve: "two" },
		];
		observeLive(
			file,
			[
				{ id: "a", name: "Fresh", enabled: true, sieve: "one" },
				{ id: "b", name: "Staged", enabled: true, sieve: "two" },
			],
			[],
			{ filters: ["Fresh"], folders: [] },
		);
		expect(file.filters.map((filter) => filter.protonId)).toEqual(["a", undefined]);
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
