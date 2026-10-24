import type { Clock, Rng } from "./jitter";
import { runPaced } from "./jitter";
import {
	assertApprovedDeletes,
	folderCreateOrder,
	folderDeleteOrder,
	type PlanAction,
	type SyncPlan,
} from "./plan";
import type { DeclaredFiltersFile } from "./schema";
import { upsertDeclaredFilter, upsertDeclaredFolder } from "./store";

export type PolicyWriteClient = {
	listFilters(): Promise<
		Array<{ id: string; name: string; enabled: boolean }>
	>;
	createFolder(input: {
		name: string;
		path?: string;
		type?: "folder" | "label";
		parentId?: string;
	}): Promise<{ id: string; name: string; path?: string }>;
	renameFolder(input: {
		id: string;
		displayName: string;
		path?: string;
		parentId?: string;
	}): Promise<{ id: string }>;
	deleteFolder(input: { id: string }): Promise<void>;
	createFilter(input: {
		name: string;
		sieve: string;
		enabled?: boolean;
	}): Promise<{ id: string; name: string }>;
	updateFilter(input: {
		id: string;
		name: string;
		sieve: string;
		enabled?: boolean;
	}): Promise<{ id: string }>;
	deleteFilter(input: { id: string }): Promise<void>;
	reorderFilters(input: { ids: string[] }): Promise<void>;
};

export async function applySyncPlan(input: {
	plan: SyncPlan;
	approvedDeletes: string[];
	client: PolicyWriteClient;
	clock: Clock;
	rng: Rng;
	declared: DeclaredFiltersFile;
	foldersByPath: Map<string, string>;
}): Promise<DeclaredFiltersFile> {
	assertApprovedDeletes(input.plan.actions, input.approvedDeletes);
	const idsByName = new Map<string, string>();
	const steps: Array<() => Promise<void>> = [];
	const creates = folderCreateOrder(
		input.plan.actions.filter(
			(action): action is Extract<PlanAction, { op: "create-folder" }> =>
				action.op === "create-folder",
		),
	);
	for (const action of creates) {
		steps.push(async () => {
			const parentPath = parentOf(action.path);
			const created = await input.client.createFolder({
				name: leaf(action.path),
				path: action.path,
				type: action.type === "system" ? "folder" : action.type,
				...(parentPath
					? { parentId: input.foldersByPath.get(parentPath) }
					: {}),
			});
			input.foldersByPath.set(action.path, created.id);
		});
	}
	for (const action of input.plan.actions) {
		if (action.op !== "rename-folder") continue;
		steps.push(async () => {
			await input.client.renameFolder({
				id: action.id,
				displayName: leaf(action.to),
				path: action.to,
				parentId: input.foldersByPath.get(parentOf(action.to) ?? ""),
			});
			input.foldersByPath.set(action.to, action.id);
		});
	}
	for (const action of input.plan.actions) {
		if (action.op === "create-filter") {
			steps.push(async () => {
				const created = await input.client.createFilter({
					name: action.name,
					sieve: action.sieve,
					enabled: action.enabled,
				});
				idsByName.set(action.name, created.id);
			});
		}
		if (
			action.op === "update-filter" ||
			action.op === "revert-filter"
		) {
			steps.push(async () => {
				await input.client.updateFilter({
					id: action.id,
					name: action.name,
					sieve: action.sieve,
					enabled: action.enabled,
				});
				idsByName.set(action.name, action.id);
			});
		}
	}
	for (const action of input.plan.actions) {
		if (action.op !== "reorder-filters") continue;
		steps.push(async () => {
			const live = await input.client.listFilters();
			for (const filter of live) {
				if (!idsByName.has(filter.name)) idsByName.set(filter.name, filter.id);
			}
			const ordered = action.names.flatMap((name) => {
				const id = idsByName.get(name);
				return id ? [id] : [];
			});
			const rest = live
				.map((filter) => filter.id)
				.filter((id) => !ordered.includes(id));
			await input.client.reorderFilters({ ids: [...ordered, ...rest] });
		});
	}
	const folderDeletes = folderDeleteOrder(
		input.plan.actions.filter(
			(action): action is Extract<PlanAction, { op: "delete-folder" }> =>
				action.op === "delete-folder",
		),
	);
	for (const action of input.plan.actions) {
		if (action.op !== "delete-filter") continue;
		steps.push(async () => {
			await input.client.deleteFilter({ id: action.id });
		});
	}
	for (const action of folderDeletes) {
		steps.push(async () => {
			await input.client.deleteFolder({ id: action.id });
		});
	}
	await runPaced(steps, input.clock, input.rng);
	const declared = input.declared;
	for (const action of input.plan.actions) {
		if (action.op === "pull-filter") {
			upsertDeclaredFilter(declared, {
				name: action.name,
				enabled: action.enabled,
				sieve: action.sieve,
				protonId: action.id,
			});
		}
		if (action.op === "pull-folder") {
			upsertDeclaredFolder(declared, {
				path: action.path,
				type: action.type,
				protonId: action.id,
			});
		}
	}
	return declared;
}

function parentOf(path: string): string | undefined {
	const segments = path.split("/").filter(Boolean);
	if (segments.length < 2) return undefined;
	return segments.slice(0, -1).join("/");
}

function leaf(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}
