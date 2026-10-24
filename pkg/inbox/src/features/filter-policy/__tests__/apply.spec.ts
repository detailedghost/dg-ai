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
					name: "Shop - Orders",
					enabled: true,
					sieve: 'require ["fileinto"];\nif true {\n  keep;\n}\n',
				},
				{ op: "reorder-filters", names: ["Fin - Banking", "Shop - Orders"] },
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

	test("sends a known parent id and omits an unknown parent", async () => {
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
					{ op: "rename-folder", id: "other", from: "shop/orders", to: "shop/returns" },
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
		expect(renames[2]?.keys).not.toContain("parentId");
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
						{ op: "create-filter", name: "Fin - Banking", enabled: true, sieve },
						{ op: "create-filter", name: "Shop - Orders", enabled: true, sieve },
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
});
