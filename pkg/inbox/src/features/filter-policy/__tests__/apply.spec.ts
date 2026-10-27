import { describe, expect, test } from "bun:test";
import { applySyncPlan, type PolicyWriteClient } from "../apply";
import { buildSyncPlan, type SyncPlan } from "../plan";
import { emptyDeclaredFilters } from "../schema";

function client(): PolicyWriteClient & { calls: string[] } {
	const calls: string[] = [];
	const filters = [{ id: "old", name: "Fin - Banking", enabled: true }];
	return {
		calls,
		async listFilters() {
			return filters.map((filter) => ({
				...filter,
				conditions: ['require ["fileinto"];\nif true {\n  keep;\n}\n'],
				actions: ['require ["fileinto"];\nif true {\n  keep;\n}\n'],
			}));
		},
		async listFolders() {
			return [];
		},
		async createFolder(input) {
			calls.push(`folder:${input.path}`);
			return { id: `id:${input.path}`, name: input.name, path: input.path };
		},
		async renameFolder(input) {
			calls.push(`rename:${input.path}`);
			return { id: input.id };
		},
		async deleteFolder(input) {
			calls.push(`delete-folder:${input.id}`);
		},
		async createFilter(input) {
			calls.push(`create:${input.name}`);
			filters.push({ id: "created", name: input.name, enabled: true });
			return { id: "created", name: input.name };
		},
		async updateFilter(input) {
			calls.push(`update:${input.id}`);
			return { id: input.id };
		},
		async deleteFilter(input) {
			calls.push(`delete-filter:${input.id}`);
		},
		async reorderFilters(input) {
			calls.push(`reorder:${input.ids.join(",")}`);
		},
	};
}

describe("apply sync plan", () => {
	test("creates parents first and deletes children first", async () => {
		const writer = client();
		const plan: SyncPlan = {
			actions: [
				{ op: "create-folder", path: "fin/banking", type: "folder" },
				{ op: "create-folder", path: "fin", type: "folder" },
				{
					op: "create-filter",
					ref: "new:0",
					name: "Shop - Orders",
					enabled: true,
					sieve: 'require ["fileinto"];\nif true {\n  keep;\n}\n',
				},
				{
					op: "reorder-filters",
					names: ["Fin - Banking", "Shop - Orders"],
					ids: ["old", "new:0"],
				},
				{ op: "delete-folder", id: "child", path: "fin/old" },
				{ op: "delete-folder", id: "parent", path: "fin" },
				{
					op: "pull-filter",
					id: "pulled",
					name: "News - Digests",
					enabled: true,
					sieve: 'require ["fileinto"];\nif true {\n  keep;\n}\n',
				},
			],
			notices: [],
		};
		const declared = emptyDeclaredFilters();
		declared.policy.safety.protectedPlusAlias = "owner+*@example.test";
		const updated = await applySyncPlan({
			plan,
			approvedDeletes: ["child", "parent"],
			client: writer,
			declared,
			foldersByPath: new Map(),
		});
		expect(writer.calls.slice(0, 2)).toEqual(["folder:fin", "folder:fin/banking"]);
		expect(writer.calls.at(-2)).toBe("delete-folder:child");
		expect(writer.calls.at(-1)).toBe("delete-folder:parent");
		expect(writer.calls).toContain("reorder:old,created");
		expect(updated.filters.map((filter) => filter.name)).toEqual(["News - Digests"]);
	});

	test("refuses a delete that was not approved for this apply", async () => {
		await expect(
			applySyncPlan({
				plan: {
					actions: [{ op: "delete-filter", id: "f1", name: "Old" }],
					notices: [],
				},
				approvedDeletes: [],
				client: client(),
				declared: emptyDeclaredFilters(),
				foldersByPath: new Map(),
			}),
		).rejects.toThrow("Refusing to delete Old without per-item approval");
	});

	test("sends a known parent id and omits a top-level parent", async () => {
		const writer = client();
		const renames: Array<{ path?: string; parentId?: string; keys: string[] }> = [];
		writer.renameFolder = async (input) => {
			renames.push({
				path: input.path,
				parentId: input.parentId,
				keys: Object.keys(input),
			});
			return { id: input.id };
		};
		const declared = emptyDeclaredFilters();
		await applySyncPlan({
			plan: {
				actions: [
					{ op: "rename-folder", id: "child", from: "fin/banking", to: "fin/receipts" },
					{ op: "rename-folder", id: "top", from: "Archive", to: "archive" },
				],
				notices: [],
			},
			approvedDeletes: [],
			client: writer,
			declared,
			foldersByPath: new Map([["fin", "parent-fin"]]),
		});
		expect(renames[0]).toMatchObject({ path: "fin/receipts", parentId: "parent-fin" });
		expect(renames[1]?.keys).not.toContain("parentId");
	});

	test("records a stopped apply so the next plan neither drifts nor duplicates", async () => {
		const writer = client();
		const sieve = 'require ["fileinto"];\nif true {\n  keep;\n}\n';
		let creates = 0;
		writer.createFilter = async (input) => {
			creates += 1;
			if (creates === 2) throw new Error("proton stopped");
			return { id: "created-1", name: input.name };
		};
		writer.listFilters = async () => [
			{
				id: "created-1",
				name: "Fin - Banking",
				enabled: true,
				conditions: [sieve],
				actions: [sieve],
			},
		];
		const declared = emptyDeclaredFilters();
		declared.filters = [
			{ name: "Fin - Banking", enabled: true, sieve },
			{ name: "Shop - Orders", enabled: true, sieve },
		];
		const saved: unknown[] = [];
		await expect(
			applySyncPlan({
				plan: {
					actions: [
						{ op: "create-filter", ref: "new:0", name: "Fin - Banking", enabled: true, sieve },
						{ op: "create-filter", ref: "new:1", name: "Shop - Orders", enabled: true, sieve },
					],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared,
				foldersByPath: new Map(),
				persist: async (file) => {
					saved.push(structuredClone(file));
				},
			}),
		).rejects.toThrow("proton stopped");
		expect(saved).toHaveLength(1);
		expect(declared.filters[0]?.protonId).toBe("created-1");
		expect(declared.filters[1]?.protonId).toBeUndefined();
		const plan = buildSyncPlan({
			desiredFilters: declared.filters,
			desiredFolders: [],
			liveFilters: [{ id: "created-1", name: "Fin - Banking", enabled: true, sieve }],
			liveFolders: [],
			observedFilters: declared.observed?.filters,
			observedFolders: declared.observed?.folders,
			naming: {
				folderSlugPattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
				folderExceptions: [],
			},
		});
		expect(plan.actions.some((action) => action.op === "create-filter" && action.name === "Fin - Banking")).toBe(false);
		expect(plan.actions).toContainEqual(
			expect.objectContaining({ op: "create-filter", name: "Shop - Orders" }),
		);
		expect(plan.notices.some((notice) => notice.op === "drift")).toBe(false);
	});
	test("records completed writes in the baseline before any later read", async () => {
		const writer = client();
		const sieve = 'require ["fileinto"];\nif true {\n  keep;\n}\n';
		writer.listFilters = async () => {
			throw new Error("read exhausted");
		};
		const declared = emptyDeclaredFilters();
		declared.filters = [{ name: "Shop - Orders", enabled: true, sieve }];
		await applySyncPlan({
			plan: {
				actions: [
					{ op: "create-filter", ref: "new:0", name: "Shop - Orders", enabled: true, sieve },
				],
				notices: [],
			},
			approvedDeletes: [],
			client: writer,
			declared,
			foldersByPath: new Map(),
		});
		expect(declared.filters[0]?.protonId).toBe("created");
		expect(declared.observed?.filters.map((filter) => filter.id)).toContain("created");
	});
	test("orders same-named filters by ID and resolves a created filter by reference", async () => {
		const writer = client();
		writer.listFilters = async () => [
			{ id: "a", name: "Same", enabled: true },
			{ id: "b", name: "Same", enabled: true },
			{ id: "created", name: "Same", enabled: true },
		];
		await applySyncPlan({
			plan: {
				actions: [
					{ op: "create-filter", ref: "new:2", name: "Same", enabled: true, sieve: "s" },
					{ op: "reorder-filters", names: ["Same", "Same", "Same"], ids: ["b", "new:2", "a"] },
				],
				notices: [],
			},
			approvedDeletes: [],
			client: writer,
			declared: emptyDeclaredFilters(),
			foldersByPath: new Map(),
		});
		expect(writer.calls).toContain("reorder:b,created,a");
	});

	test("refuses a reorder that lists one ID twice", async () => {
		const writer = client();
		writer.listFilters = async () => [{ id: "a", name: "A", enabled: true }];
		await expect(
			applySyncPlan({
				plan: {
					actions: [{ op: "reorder-filters", names: ["A", "A"], ids: ["a", "a"] }],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared: emptyDeclaredFilters(),
				foldersByPath: new Map(),
			}),
		).rejects.toThrow("more than once");
		expect(writer.calls).toEqual([]);
	});

	test("refuses a nested create whose parent cannot be resolved before writing anything", async () => {
		const writer = client();
		await expect(
			applySyncPlan({
				plan: {
					actions: [
						{ op: "create-folder", path: "other", type: "folder" },
						{ op: "create-folder", path: "fin/receipts", type: "folder" },
					],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared: emptyDeclaredFilters(),
				foldersByPath: new Map(),
			}),
		).rejects.toThrow("parent folder fin cannot be resolved");
		expect(writer.calls).toEqual([]);
	});

	test("refuses a rename whose target parent cannot be resolved before writing anything", async () => {
		const writer = client();
		await expect(
			applySyncPlan({
				plan: {
					actions: [
						{ op: "create-folder", path: "other", type: "folder" },
						{ op: "rename-folder", id: "r-id", from: "receipts", to: "fin/receipts" },
					],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared: emptyDeclaredFilters(),
				foldersByPath: new Map([["receipts", "r-id"]]),
			}),
		).rejects.toThrow("parent folder fin cannot be resolved");
		expect(writer.calls).toEqual([]);
	});

	test("renames a parent before creating its new child", async () => {
		const writer = client();
		await applySyncPlan({
			plan: {
				actions: [
					{ op: "create-folder", path: "finance/receipts", type: "folder" },
					{ op: "rename-folder", id: "fin-id", from: "fin", to: "finance" },
				],
				notices: [],
			},
			approvedDeletes: [],
			client: writer,
			declared: emptyDeclaredFilters(),
			foldersByPath: new Map([["fin", "fin-id"]]),
		});
		expect(writer.calls).toEqual(["rename:finance", "folder:finance/receipts"]);
	});

	test("creates a replacement for a renamed folder only after the rename frees the path", async () => {
		const writer = client();
		await applySyncPlan({
			plan: {
				actions: [
					{ op: "create-folder", path: "fin", type: "folder" },
					{ op: "create-folder", path: "fin/receipts", type: "folder" },
					{ op: "rename-folder", id: "fin-id", from: "fin", to: "finance" },
				],
				notices: [],
			},
			approvedDeletes: [],
			client: writer,
			declared: emptyDeclaredFilters(),
			foldersByPath: new Map([["fin", "fin-id"]]),
		});
		expect(writer.calls).toEqual(["rename:finance", "folder:fin", "folder:fin/receipts"]);
	});

	test("refuses a child create under a path a rename vacates before writing anything", async () => {
		const writer = client();
		await expect(
			applySyncPlan({
				plan: {
					actions: [
						{ op: "create-folder", path: "fin/receipts", type: "folder" },
						{ op: "rename-folder", id: "fin-id", from: "fin", to: "finance" },
					],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared: emptyDeclaredFilters(),
				foldersByPath: new Map([["fin", "fin-id"]]),
			}),
		).rejects.toThrow("parent folder fin cannot be resolved");
		expect(writer.calls).toEqual([]);
	});

	test("drops pulled-away declarations and follows a pulled filter order", async () => {
		const declared = emptyDeclaredFilters();
		declared.filters = [
			{ name: "A", enabled: true, sieve: "s", protonId: "a" },
			{ name: "B", enabled: true, sieve: "s", protonId: "b" },
			{ name: "C", enabled: true, sieve: "s", protonId: "c" },
		];
		declared.folders = [{ path: "gone", type: "folder", protonId: "g" }];
		const updated = await applySyncPlan({
			plan: {
				actions: [
					{ op: "drop-filter", id: "a", name: "A" },
					{ op: "drop-folder", id: "g", path: "gone" },
					{ op: "pull-filter-order", ids: ["c", "b"] },
				],
				notices: [],
			},
			approvedDeletes: [],
			client: client(),
			declared,
			foldersByPath: new Map(),
		});
		expect(updated.filters.map((filter) => filter.protonId)).toEqual(["c", "b"]);
		expect(updated.folders).toEqual([]);
	});
});

describe("partial apply recovery", () => {
	test("records a completed reorder in the observed baseline when a later delete fails", async () => {
		const writer = client();
		const order = ["a", "b", "c"];
		writer.listFilters = async () =>
			order.map((id) => ({
				id,
				name: id,
				enabled: true,
				conditions: ["keep;"],
				actions: ["keep;"],
			}));
		writer.reorderFilters = async (input) => {
			order.splice(0, order.length, ...input.ids);
		};
		writer.deleteFilter = async () => {
			throw new Error("delete failed");
		};
		const declared = emptyDeclaredFilters();
		declared.observed = {
			filters: ["a", "b", "c"].map((id, index) => ({
				id,
				name: id,
				enabled: true,
				sieve: "keep;",
				sequence: index + 1,
			})),
			folders: [],
		};
		let persisted: typeof declared | undefined;
		await expect(
			applySyncPlan({
				plan: {
					actions: [
						{ op: "reorder-filters", names: ["b", "a"], ids: ["b", "a"] },
						{ op: "delete-filter", id: "c", name: "c" },
					],
					notices: [],
				},
				approvedDeletes: ["c"],
				client: writer,
				declared,
				foldersByPath: new Map(),
				persist: async (file) => {
					persisted = structuredClone(file);
				},
			}),
		).rejects.toThrow("delete failed");
		expect(persisted?.observed?.filters.map((filter) => [filter.id, filter.sequence])).toEqual([
			["b", 1],
			["a", 2],
			["c", 3],
		]);
		expect(persisted?.observed?.filters[0]?.sieve).toBe("keep;");
	});
});

describe("apply identity and ordering", () => {
	const body = 'require ["fileinto"];\nif true {\n  fileinto "X";\n}\n';

	test("gives a created filter its own ID without touching an unchanged same-named one", async () => {
		const writer = client();
		const declared = emptyDeclaredFilters();
		declared.filters = [
			{ name: "Same", enabled: true, sieve: body, protonId: "a" },
			{ name: "Same", enabled: true, sieve: body },
		];
		const updated = await applySyncPlan({
			plan: {
				actions: [{ op: "create-filter", ref: "new:1", name: "Same", enabled: true, sieve: body }],
				notices: [],
			},
			approvedDeletes: [],
			client: writer,
			declared,
			foldersByPath: new Map(),
		});
		expect(updated.filters.map((filter) => filter.protonId)).toEqual(["a", "created"]);
	});

	test("records an update that Proton committed before its response failed", async () => {
		const writer = client();
		let live = { id: "f1", name: "Old", enabled: true, sieve: "old" };
		writer.listFilters = async () => [live];
		writer.updateFilter = async (input) => {
			live = { id: input.id, name: input.name, enabled: input.enabled ?? true, sieve: input.sieve };
			throw new Error("timeout");
		};
		const declared = emptyDeclaredFilters();
		declared.filters = [{ name: "New", enabled: true, sieve: "new", protonId: "f1" }];
		declared.observed = {
			filters: [{ id: "f1", name: "Old", enabled: true, sieve: "old" }],
			folders: [],
		};
		await expect(
			applySyncPlan({
				plan: {
					actions: [
						{
							op: "update-filter",
							id: "f1",
							fromName: "Old",
							name: "New",
							enabled: true,
							sieve: "new",
							changes: ["name", "sieve"],
						},
					],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared,
				foldersByPath: new Map(),
			}),
		).rejects.toThrow("timeout");
		expect(declared.observed?.filters[0]).toMatchObject({ name: "New", sieve: "new" });
	});

	test("records a second same-named create that Proton committed before its response failed", async () => {
		const writer = client();
		const live = [{ id: "a", name: "Same", enabled: true, sieve: body }];
		writer.listFilters = async () => live;
		writer.createFilter = async (input) => {
			live.push({ id: "b", name: input.name, enabled: true, sieve: input.sieve });
			throw new Error("timeout");
		};
		const declared = emptyDeclaredFilters();
		declared.filters = [
			{ name: "Same", enabled: true, sieve: body, protonId: "a" },
			{ name: "Same", enabled: true, sieve: body },
		];
		declared.observed = {
			filters: [{ id: "a", name: "Same", enabled: true, sieve: body }],
			folders: [],
		};
		await expect(
			applySyncPlan({
				plan: {
					actions: [{ op: "create-filter", ref: "new:1", name: "Same", enabled: true, sieve: body }],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared,
				foldersByPath: new Map(),
			}),
		).rejects.toThrow("timeout");
		expect(declared.filters.map((filter) => filter.protonId)).toEqual(["a", "b"]);
		expect(declared.observed?.filters.map((filter) => filter.id)).toEqual(["a", "b"]);
	});

	test("records a folder rename that Proton committed before its response failed", async () => {
		const writer = client();
		let folder = { id: "fin-id", name: "fin", path: "fin", type: "folder" as const };
		writer.listFolders = async () => [folder];
		writer.renameFolder = async (input) => {
			folder = { id: input.id, name: input.displayName, path: input.path ?? "", type: "folder" };
			throw new Error("timeout");
		};
		const declared = emptyDeclaredFilters();
		declared.observed = {
			filters: [],
			folders: [{ id: "fin-id", path: "fin", name: "fin", type: "folder" }],
		};
		await expect(
			applySyncPlan({
				plan: {
					actions: [{ op: "rename-folder", id: "fin-id", from: "fin", to: "finance" }],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared,
				foldersByPath: new Map([["fin", "fin-id"]]),
			}),
		).rejects.toThrow("timeout");
		expect(declared.observed?.folders[0]).toMatchObject({ id: "fin-id", path: "finance" });
	});

	test("records a filter delete that Proton committed before its response failed", async () => {
		const writer = client();
		let live = [{ id: "f1", name: "Old", enabled: true, sieve: body }];
		writer.listFilters = async () => live;
		writer.deleteFilter = async () => {
			live = [];
			throw new Error("timeout");
		};
		const declared = emptyDeclaredFilters();
		declared.observed = {
			filters: [{ id: "f1", name: "Old", enabled: true, sieve: body }],
			folders: [],
		};
		await expect(
			applySyncPlan({
				plan: { actions: [{ op: "delete-filter", id: "f1", name: "Old" }], notices: [] },
				approvedDeletes: ["f1"],
				client: writer,
				declared,
				foldersByPath: new Map(),
			}),
		).rejects.toThrow("timeout");
		expect(declared.observed?.filters).toEqual([]);
	});

	test("records a reorder that Proton committed before its response failed", async () => {
		const writer = client();
		let live = [
			{ id: "a", name: "A", enabled: true, sieve: body },
			{ id: "b", name: "B", enabled: true, sieve: body },
		];
		writer.listFilters = async () => live;
		writer.reorderFilters = async (input) => {
			live = input.ids.flatMap((id) => live.filter((filter) => filter.id === id));
			throw new Error("timeout");
		};
		const declared = emptyDeclaredFilters();
		declared.observed = { filters: [...live], folders: [] };
		await expect(
			applySyncPlan({
				plan: { actions: [{ op: "reorder-filters", names: ["B", "A"], ids: ["b", "a"] }], notices: [] },
				approvedDeletes: [],
				client: writer,
				declared,
				foldersByPath: new Map(),
			}),
		).rejects.toThrow("timeout");
		expect(declared.observed?.filters.map((filter) => filter.id)).toEqual(["b", "a"]);
	});

	test("deletes a Spam filter before the keep or stop filter that guards it", async () => {
		const writer = client();
		writer.listFilters = async () => [
			{ id: "guard", name: "Guard", enabled: true, sieve: "keep;" },
			{ id: "spam", name: "Spam", enabled: true, sieve: body },
		];
		await applySyncPlan({
			plan: {
				actions: [
					{ op: "delete-filter", id: "guard", name: "Guard" },
					{ op: "delete-filter", id: "spam", name: "Spam" },
				],
				notices: [],
			},
			approvedDeletes: ["guard", "spam"],
			client: writer,
			declared: emptyDeclaredFilters(),
			foldersByPath: new Map(),
		});
		expect(writer.calls).toEqual(["delete-filter:spam", "delete-filter:guard"]);
	});

	test("deletes a later Spam filter that itself stops before the guard ahead of it", async () => {
		const writer = client();
		const spamStop = `require ["fileinto"];\nfileinto "Spam";\nstop;\n`;
		writer.listFilters = async () => [
			{ id: "guard", name: "Guard", enabled: true, sieve: "stop;" },
			{ id: "spam", name: "Spam", enabled: true, sieve: spamStop },
		];
		await applySyncPlan({
			plan: {
				actions: [
					{ op: "delete-filter", id: "guard", name: "Guard" },
					{ op: "delete-filter", id: "spam", name: "Spam" },
				],
				notices: [],
			},
			approvedDeletes: ["guard", "spam"],
			client: writer,
			declared: emptyDeclaredFilters(),
			foldersByPath: new Map(),
		});
		expect(writer.calls).toEqual(["delete-filter:spam", "delete-filter:guard"]);
	});

	test("deletes a later filter before weakening the guard ahead of it", async () => {
		const writer = client();
		writer.listFilters = async () => [
			{ id: "guard", name: "Guard", enabled: true, sieve: "stop;" },
			{ id: "spam", name: "Spam", enabled: true, sieve: body },
		];
		await applySyncPlan({
			plan: {
				actions: [
					{
						op: "update-filter",
						id: "guard",
						fromName: "Guard",
						name: "Guard",
						sieve: "require [\"fileinto\"];\nkeep;\n",
						enabled: false,
						changes: ["sieve", "enabled"],
					},
					{ op: "delete-filter", id: "spam", name: "Spam" },
				],
				notices: [],
			},
			approvedDeletes: ["spam"],
			client: writer,
			declared: emptyDeclaredFilters(),
			foldersByPath: new Map(),
		});
		expect(writer.calls).toEqual(["delete-filter:spam", "update:guard"]);
	});

	test("refuses a create under a path whose ancestor rename moves it", async () => {
		const writer = client();
		await expect(
			applySyncPlan({
				plan: {
					actions: [
						{ op: "rename-folder", id: "fin-id", from: "fin", to: "finance" },
						{ op: "create-folder", path: "fin/reports/2026", type: "folder" },
					],
					notices: [],
				},
				approvedDeletes: [],
				client: writer,
				declared: emptyDeclaredFilters(),
				foldersByPath: new Map([
					["fin", "fin-id"],
					["fin/reports", "rep-id"],
				]),
			}),
		).rejects.toThrow("parent folder fin/reports cannot be resolved");
		expect(writer.calls).toEqual([]);
	});
});

