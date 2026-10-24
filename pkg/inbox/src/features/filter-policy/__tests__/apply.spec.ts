import { describe, expect, test } from "bun:test";
import { applySyncPlan, type PolicyWriteClient } from "../apply";
import type { SyncPlan } from "../plan";
import { emptyDeclaredFilters } from "../schema";
import type { Clock } from "../jitter";

function client(): PolicyWriteClient & { calls: string[] } {
	const calls: string[] = [];
	const filters = [{ id: "old", name: "Fin - Banking", enabled: true }];
	return {
		calls,
		async listFilters() {
			return filters;
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

const clock: Clock = { now: () => 0, sleep: async () => undefined };

describe("apply sync plan", () => {
	test("creates parents first, deletes children first, and paces every write", async () => {
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
			clock,
			rng: () => 0.4,
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
				clock,
				rng: () => 0.2,
				declared: emptyDeclaredFilters(),
				foldersByPath: new Map(),
			}),
		).rejects.toThrow("Refusing to delete Old without per-item approval");
	});
});
