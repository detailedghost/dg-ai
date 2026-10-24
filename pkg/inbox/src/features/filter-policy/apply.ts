import { fullSieveOrThrow } from "./parse";
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
		Array<{
			id: string;
			name: string;
			enabled: boolean;
			conditions?: string[];
			actions?: string[];
			sieve?: string;
		}>
	>;
	listFolders(): Promise<
		Array<{
			id: string;
			name: string;
			path?: string;
			type?: "folder" | "label" | "system";
		}>
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

type AppliedStep = { action: PlanAction; id?: string };

type LiveSnapshot = {
	filters: Array<{
		id: string;
		name: string;
		enabled: boolean;
		sieve: string;
	}>;
	folders: Array<{
		id: string;
		name: string;
		path: string;
		type: "folder" | "label" | "system";
	}>;
};

export async function applySyncPlan(input: {
	plan: SyncPlan;
	approvedDeletes: string[];
	client: PolicyWriteClient;
	declared: DeclaredFiltersFile;
	foldersByPath: Map<string, string>;
	persist?: (file: DeclaredFiltersFile) => Promise<void>;
}): Promise<DeclaredFiltersFile> {
	assertApprovedDeletes(input.plan.actions, input.approvedDeletes);
	const idsByName = new Map<string, string>();
	const done: AppliedStep[] = [];
	const steps: Array<() => Promise<void>> = [];
	const creates = folderCreateOrder(
		input.plan.actions.filter(
			(action): action is Extract<PlanAction, { op: "create-folder" }> =>
				action.op === "create-folder",
		),
	);
	for (const action of creates) {
		steps.push(async () => {
			const parentId = parentIdFor(action.path, input.foldersByPath);
			const created = await input.client.createFolder({
				name: leaf(action.path),
				path: action.path,
				type: action.type === "system" ? "folder" : action.type,
				...(parentId ? { parentId } : {}),
			});
			input.foldersByPath.set(action.path, created.id);
			done.push({ action, id: created.id });
		});
	}
	for (const action of input.plan.actions) {
		if (action.op !== "rename-folder") continue;
		steps.push(async () => {
			const parentId = parentIdFor(action.to, input.foldersByPath);
			await input.client.renameFolder({
				id: action.id,
				displayName: leaf(action.to),
				path: action.to,
				...(parentId ? { parentId } : {}),
			});
			input.foldersByPath.set(action.to, action.id);
			done.push({ action, id: action.id });
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
				done.push({ action, id: created.id });
			});
		}
		if (action.op === "update-filter" || action.op === "revert-filter") {
			steps.push(async () => {
				await input.client.updateFilter({
					id: action.id,
					name: action.name,
					sieve: action.sieve,
					enabled: action.enabled,
				});
				idsByName.set(action.name, action.id);
				done.push({ action, id: action.id });
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
			done.push({ action });
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
			done.push({ action, id: action.id });
		});
	}
	for (const action of folderDeletes) {
		steps.push(async () => {
			await input.client.deleteFolder({ id: action.id });
			done.push({ action, id: action.id });
		});
	}
	try {
		for (const step of steps) {
			await step();
		}
	} catch (error) {
		await reconcilePartial(input, done);
		throw error;
	}
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

export function recordAppliedProgress(
	file: DeclaredFiltersFile,
	done: AppliedStep[],
	live: LiveSnapshot,
): void {
	if (!file.observed) file.observed = { filters: [], folders: [] };
	for (const step of done) {
		const action = step.action;
		if (action.op === "create-filter" || action.op === "update-filter" || action.op === "revert-filter") {
			const id = step.id ?? actionId(action);
			if (!id) continue;
			const found = live.filters.find((filter) => filter.id === id || filter.name === action.name);
			const name = found?.name ?? action.name;
			const enabled = found?.enabled ?? action.enabled;
			const sieve = found?.sieve || action.sieve;
			const desired = file.filters.find((filter) => filter.name === action.name || filter.protonId === id);
			if (desired) desired.protonId = found?.id ?? id;
			upsertObservedFilter(file, { id: found?.id ?? id, name, enabled, sieve });
		}
		if (action.op === "create-folder") {
			const id = step.id;
			if (!id) continue;
			const found = live.folders.find((folder) => folder.id === id || folder.path === action.path);
			const path = found?.path || action.path;
			const desired = file.folders.find((folder) => folder.path === action.path || folder.protonId === id);
			if (desired) desired.protonId = found?.id ?? id;
			upsertObservedFolder(file, {
				id: found?.id ?? id,
				path,
				name: found?.name ?? leaf(path),
				type: found?.type ?? action.type,
			});
		}
		if (action.op === "rename-folder") {
			const found = live.folders.find((folder) => folder.id === action.id);
			const path = found?.path || action.to;
			const desired = file.folders.find(
				(folder) => folder.protonId === action.id || folder.path === action.to,
			);
			if (desired) {
				desired.protonId = action.id;
				if (found?.path) desired.path = found.path;
			}
			upsertObservedFolder(file, {
				id: action.id,
				path,
				name: found?.name ?? leaf(path),
				type: found?.type ?? "folder",
			});
		}
		if (action.op === "delete-filter") {
			if (live.filters.some((filter) => filter.id === action.id)) continue;
			file.observed.filters = file.observed.filters.filter((filter) => filter.id !== action.id);
		}
		if (action.op === "delete-folder") {
			if (live.folders.some((folder) => folder.id === action.id)) continue;
			file.observed.folders = file.observed.folders.filter((folder) => folder.id !== action.id);
		}
	}
}

async function reconcilePartial(
	input: {
		client: PolicyWriteClient;
		declared: DeclaredFiltersFile;
		persist?: (file: DeclaredFiltersFile) => Promise<void>;
	},
	done: AppliedStep[],
): Promise<void> {
	let live = emptySnapshot();
	try {
		live = await readSnapshot(input.client);
	} catch {
		live = snapshotFromDone(done);
	}
	recordAppliedProgress(input.declared, done, live);
	try {
		await input.persist?.(input.declared);
	} catch {
		return;
	}
}

async function readSnapshot(client: PolicyWriteClient): Promise<LiveSnapshot> {
	const folders = await client.listFolders();
	const filters = await client.listFilters();
	return {
		folders: folders.map((folder) => ({
			id: folder.id,
			name: folder.name,
			path: folder.path?.trim() || folder.name,
			type: folder.type ?? "folder",
		})),
		filters: filters.map((filter) => ({
			id: filter.id,
			name: filter.name,
			enabled: filter.enabled,
			sieve: sieveOf(filter),
		})),
	};
}

function snapshotFromDone(done: AppliedStep[]): LiveSnapshot {
	const filters: LiveSnapshot["filters"] = [];
	const folders: LiveSnapshot["folders"] = [];
	for (const step of done) {
		const action = step.action;
		if (
			(action.op === "create-filter" ||
				action.op === "update-filter" ||
				action.op === "revert-filter") &&
			step.id
		) {
			filters.push({
				id: step.id,
				name: action.name,
				enabled: action.enabled,
				sieve: action.sieve,
			});
		}
		if (action.op === "create-folder" && step.id) {
			folders.push({
				id: step.id,
				path: action.path,
				name: leaf(action.path),
				type: action.type,
			});
		}
		if (action.op === "rename-folder") {
			folders.push({
				id: action.id,
				path: action.to,
				name: leaf(action.to),
				type: "folder",
			});
		}
	}
	return { filters, folders };
}

function emptySnapshot(): LiveSnapshot {
	return { filters: [], folders: [] };
}

function sieveOf(filter: {
	conditions?: string[];
	actions?: string[];
	sieve?: string;
}): string {
	if (filter.sieve?.trim()) return filter.sieve;
	try {
		return fullSieveOrThrow(filter);
	} catch {
		return "";
	}
}

function actionId(action: PlanAction): string | undefined {
	if (action.op === "update-filter" || action.op === "revert-filter") return action.id;
	return undefined;
}

function upsertObservedFilter(
	file: DeclaredFiltersFile,
	filter: { id: string; name: string; enabled: boolean; sieve: string },
): void {
	if (!file.observed) file.observed = { filters: [], folders: [] };
	const index = file.observed.filters.findIndex((item) => item.id === filter.id);
	if (index >= 0) {
		const current = file.observed.filters[index];
		if (!current) return;
		file.observed.filters[index] = { ...current, ...filter };
		return;
	}
	file.observed.filters.push(filter);
}

function upsertObservedFolder(
	file: DeclaredFiltersFile,
	folder: {
		id: string;
		path: string;
		name: string;
		type: "folder" | "label" | "system";
	},
): void {
	if (!file.observed) file.observed = { filters: [], folders: [] };
	const index = file.observed.folders.findIndex((item) => item.id === folder.id);
	if (index >= 0) {
		file.observed.folders[index] = folder;
		return;
	}
	file.observed.folders.push(folder);
}

function parentIdFor(path: string, foldersByPath: Map<string, string>): string | undefined {
	const parent = parentOf(path);
	if (!parent) return undefined;
	return foldersByPath.get(parent);
}

function parentOf(path: string): string | undefined {
	const segments = path.split("/").filter(Boolean);
	if (segments.length < 2) return undefined;
	return segments.slice(0, -1).join("/");
}

function leaf(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}
