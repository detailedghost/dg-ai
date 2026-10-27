import { fullSieveOrThrow } from "./parse";
import {
	assertApprovedDeletes,
	folderCreateOrder,
	folderDeleteOrder,
	type PlanAction,
	type SyncPlan,
} from "./plan";
import { guardsChain } from "./safety";
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
		moveToRoot?: boolean;
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

type AppliedStep = { action: PlanAction; id?: string; order?: string[] };

type FolderStep = {
	kind: "create" | "rename";
	target: string;
	vacates?: string;
	run: () => Promise<void>;
};

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
	const idsByRef = new Map<string, string>();
	const folderSteps: FolderStep[] = [];
	const scheduleFolder = (
		kind: FolderStep["kind"],
		target: string,
		run: () => Promise<void>,
		vacates?: string,
	): void => {
		folderSteps.push({ kind, target, run, ...(vacates ? { vacates } : {}) });
	};
	const done: AppliedStep[] = [];
	let inFlight: AppliedStep | undefined;
	const steps: Array<() => Promise<void>> = [];
	const creates = folderCreateOrder(
		input.plan.actions.filter(
			(action): action is Extract<PlanAction, { op: "create-folder" }> =>
				action.op === "create-folder",
		),
	);
	for (const action of creates) {
		scheduleFolder("create", action.path, async () => {
			inFlight = { action };
			const parentId = parentIdFor(action.path, input.foldersByPath);
			const created = await input.client.createFolder({
				name: leaf(action.path),
				path: action.path,
				type: action.type === "system" ? "folder" : action.type,
				...(parentId ? { parentId } : {}),
			});
			inFlight = undefined;
			input.foldersByPath.set(action.path, created.id);
			done.push({ action, id: created.id });
		});
	}
	for (const action of input.plan.actions) {
		if (action.op !== "rename-folder") continue;
		scheduleFolder("rename", action.to, async () => {
			inFlight = { action, id: action.id };
			const parentId = parentIdFor(action.to, input.foldersByPath);
			await input.client.renameFolder({
				id: action.id,
				displayName: leaf(action.to),
				path: action.to,
				...placement(action.to, parentId),
			});
			inFlight = undefined;
			for (const path of [...input.foldersByPath.keys()]) {
				if (isWithin(path, action.from)) input.foldersByPath.delete(path);
			}
			input.foldersByPath.set(action.to, action.id);
			done.push({ action, id: action.id });
		}, action.from);
	}
	steps.push(
		...orderFolderSteps(folderSteps, new Set(input.foldersByPath.keys())).map(
			(step) => step.run,
		),
	);
	const filterWrites: Array<{ id: string; run: () => Promise<void> }> = [];
	for (const action of input.plan.actions) {
		if (action.op === "create-filter") {
			steps.push(async () => {
				inFlight = { action };
				const created = await input.client.createFilter({
					name: action.name,
					sieve: action.sieve,
					enabled: action.enabled,
				});
				inFlight = undefined;
				if (action.ref) idsByRef.set(action.ref, created.id);
				done.push({ action, id: created.id });
			});
		}
		if (action.op === "update-filter" || action.op === "revert-filter") {
			filterWrites.push({
				id: action.id,
				run: async () => {
					inFlight = { action, id: action.id };
					await input.client.updateFilter({
						id: action.id,
						name: action.name,
						sieve: action.sieve,
						enabled: action.enabled,
					});
					inFlight = undefined;
					done.push({ action, id: action.id });
				},
			});
		}
	}
	for (const action of input.plan.actions) {
		if (action.op !== "reorder-filters") continue;
		steps.push(async () => {
			const live = await input.client.listFilters();
			const liveIds = new Set(live.map((filter) => filter.id));
			if (!action.ids) {
				throw new Error("Refusing to reorder filters without stable filter IDs");
			}
			const resolved = action.ids.map((ref) => {
				const id = idsByRef.get(ref) ?? ref;
				if (id.startsWith("new:")) {
					throw new Error(`Reorder references a filter that was not created: ${ref}`);
				}
				return id;
			});
			const repeated = resolved.find(
				(id, index) => resolved.indexOf(id) !== index,
			);
			if (repeated) {
				throw new Error(`Reorder lists filter ${repeated} more than once`);
			}
			const ordered = resolved.filter((id) => liveIds.has(id));
			const rest = live
				.map((filter) => filter.id)
				.filter((id) => !ordered.includes(id));
			const order = [...ordered, ...rest];
			inFlight = { action, order };
			await input.client.reorderFilters({ ids: order });
			inFlight = undefined;
			done.push({ action, order });
		});
	}
	const folderDeletes = folderDeleteOrder(
		input.plan.actions.filter(
			(action): action is Extract<PlanAction, { op: "delete-folder" }> =>
				action.op === "delete-folder",
		),
	);
	const filterDeletes = input.plan.actions.filter(
		(action): action is Extract<PlanAction, { op: "delete-filter" }> =>
			action.op === "delete-filter",
	);
	for (const action of filterDeletes) {
		filterWrites.push({
			id: action.id,
			run: async () => {
				inFlight = { action, id: action.id };
				await input.client.deleteFilter({ id: action.id });
				inFlight = undefined;
				done.push({ action, id: action.id });
			},
		});
	}
	if (filterWrites.length > 0) {
		steps.push(async () => {
			if (filterDeletes.length > 0) {
				const live = await input.client.listFilters();
				const position = new Map(live.map((filter, index) => [filter.id, index]));
				filterWrites.sort(
					(left, right) =>
						(position.get(right.id) ?? -1) - (position.get(left.id) ?? -1),
				);
			}
			for (const write of filterWrites) await write.run();
		});
	}
	for (const action of folderDeletes) {
		steps.push(async () => {
			inFlight = { action, id: action.id };
			await input.client.deleteFolder({ id: action.id });
			inFlight = undefined;
			done.push({ action, id: action.id });
		});
	}
	try {
		for (const step of steps) {
			await step();
		}
	} catch (error) {
		await reconcilePartial(input, done, inFlight);
		throw error;
	}
	recordAppliedProgress(input.declared, done, snapshotFromDone(done));
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
		if (action.op === "drop-filter") {
			declared.filters = declared.filters.filter(
				(filter) => filter.protonId !== action.id,
			);
		}
		if (action.op === "drop-folder") {
			declared.folders = declared.folders.filter(
				(folder) => folder.protonId !== action.id,
			);
		}
	}
	for (const action of input.plan.actions) {
		if (action.op === "pull-filter-order") {
			sortDeclaredFilters(declared, action.ids);
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
			const found = live.filters.find((filter) => filter.id === id);
			const name = found?.name ?? action.name;
			const enabled = found?.enabled ?? action.enabled;
			const sieve = found?.sieve || action.sieve;
			const desired =
				action.op === "create-filter"
					? declaredForRef(file, action.ref)
					: file.filters.find((filter) => filter.protonId === id);
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
		if (action.op === "reorder-filters" && step.order) {
			recordObservedOrder(file, step.order);
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
	inFlight?: AppliedStep,
): Promise<void> {
	let live = emptySnapshot();
	try {
		live = await readSnapshot(input.client);
		const landedStep = inFlight && verifyLanded(inFlight, live, input.declared, done);
		if (landedStep) done.push(landedStep);
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

function verifyLanded(
	step: AppliedStep,
	live: LiveSnapshot,
	file: DeclaredFiltersFile,
	done: AppliedStep[],
): AppliedStep | undefined {
	const action = step.action;
	if (action.op === "rename-folder") {
		const found = live.folders.find((folder) => folder.id === action.id);
		return found?.path === action.to ? step : undefined;
	}
	if (action.op === "create-folder") {
		const known = new Set<string>([
			...done.flatMap((item) => (item.id ? [item.id] : [])),
			...(file.observed?.folders ?? []).map((folder) => folder.id),
			...file.folders.flatMap((folder) => (folder.protonId ? [folder.protonId] : [])),
		]);
		const created = live.folders.filter(
			(folder) => folder.path === action.path && !known.has(folder.id),
		);
		return created.length === 1 && created[0]
			? { action, id: created[0].id }
			: undefined;
	}
	if (action.op === "delete-filter") {
		return live.filters.some((filter) => filter.id === action.id) ? undefined : step;
	}
	if (action.op === "delete-folder") {
		return live.folders.some((folder) => folder.id === action.id) ? undefined : step;
	}
	if (action.op === "reorder-filters") {
		const { order } = step;
		return order &&
			order.length === live.filters.length &&
			order.every((id, index) => live.filters[index]?.id === id)
			? step
			: undefined;
	}
	if (
		action.op !== "update-filter" &&
		action.op !== "revert-filter" &&
		action.op !== "create-filter"
	) {
		return undefined;
	}
	const matches = (filter: LiveSnapshot["filters"][number]): boolean =>
		filter.name === action.name &&
		filter.enabled === action.enabled &&
		filter.sieve === action.sieve;
	if (action.op !== "create-filter") {
		const found = live.filters.find((filter) => filter.id === action.id);
		return found && matches(found) ? step : undefined;
	}
	const known = new Set<string>([
		...done.flatMap((item) => (item.id ? [item.id] : [])),
		...(file.observed?.filters ?? []).map((filter) => filter.id),
		...file.filters.flatMap((filter) => (filter.protonId ? [filter.protonId] : [])),
	]);
	const candidates = live.filters.filter((filter) => !known.has(filter.id) && matches(filter));
	return candidates.length === 1 && candidates[0]
		? { action, id: candidates[0].id }
		: undefined;
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

function declaredForRef(
	file: DeclaredFiltersFile,
	ref: string | undefined,
): DeclaredFiltersFile["filters"][number] | undefined {
	const match = ref?.match(/^new:(\d+)$/);
	return match ? file.filters[Number(match[1])] : undefined;
}

function isWithin(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(`${ancestor}/`);
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

function recordObservedOrder(file: DeclaredFiltersFile, order: string[]): void {
	if (!file.observed) return;
	const position = (id: string): number => {
		const index = order.indexOf(id);
		return index < 0 ? order.length : index;
	};
	const sorted = file.observed.filters
		.map((filter, index) => ({ filter, index }))
		.sort(
			(left, right) =>
				position(left.filter.id) - position(right.filter.id) ||
				left.index - right.index,
		)
		.map((entry) => entry.filter);
	const sequenced = sorted.some((filter) => filter.sequence !== undefined);
	file.observed.filters = sequenced
		? sorted.map((filter, index) => ({ ...filter, sequence: index + 1 }))
		: sorted;
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

function sortDeclaredFilters(file: DeclaredFiltersFile, ids: string[]): void {
	const position = (filter: { protonId?: string }): number => {
		const index = filter.protonId ? ids.indexOf(filter.protonId) : -1;
		return index < 0 ? ids.length : index;
	};
	file.filters = file.filters
		.map((filter, index) => ({ filter, index }))
		.sort(
			(left, right) =>
				position(left.filter) - position(right.filter) || left.index - right.index,
		)
		.map((entry) => entry.filter);
}

function orderFolderSteps(steps: FolderStep[], known: Set<string>): FolderStep[] {
	const pending = [...steps];
	const ordered: FolderStep[] = [];
	while (pending.length > 0) {
		const index = pending.findIndex(
			(step) =>
				!pending.some(
					(other) =>
						other !== step &&
						(other.target === parentOf(step.target) ||
							(other.vacates !== undefined &&
								isWithin(step.target, other.vacates))),
				),
		);
		const [next] = pending.splice(Math.max(index, 0), 1);
		if (!next) break;
		const parent = parentOf(next.target);
		if (parent && !known.has(parent)) {
			throw new Error(
				`Refusing to ${next.kind} ${next.target}: parent folder ${parent} cannot be resolved`,
			);
		}
		if (next.vacates) {
			const vacated = next.vacates;
			for (const path of [...known]) {
				if (isWithin(path, vacated)) known.delete(path);
			}
		}
		known.add(next.target);
		ordered.push(next);
	}
	return ordered;
}

function placement(
	path: string,
	parentId: string | undefined,
): { moveToRoot: true } | { parentId: string } | Record<string, never> {
	if (parentOf(path) === undefined) return { moveToRoot: true };
	if (parentId) return { parentId };
	return {};
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
