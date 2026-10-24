import { createHash } from "node:crypto";
import {
	suggestFilterRename,
	suggestFolderPath,
	type NamingPolicy,
} from "./naming";
import { normalizeSieve } from "./parse";

export type LiveFilter = {
	id: string;
	name: string;
	enabled: boolean;
	sieve: string;
	sequence?: number;
};

export type LiveFolder = {
	id: string;
	path: string;
	name: string;
	type: "folder" | "label" | "system";
};

export type DesiredFilter = {
	name: string;
	enabled: boolean;
	sieve: string;
	protonId?: string;
};

export type DesiredFolder = {
	path: string;
	type: "folder" | "label" | "system";
	protonId?: string;
};

export type PlanAction =
	| { op: "create-filter"; name: string; enabled: boolean; sieve: string }
	| {
			op: "update-filter";
			id: string;
			fromName: string;
			name: string;
			enabled: boolean;
			sieve: string;
			changes: Array<"name" | "sieve" | "enabled">;
	  }
	| { op: "reorder-filters"; names: string[] }
	| { op: "delete-filter"; id: string; name: string }
	| {
			op: "create-folder";
			path: string;
			type: "folder" | "label" | "system";
	  }
	| { op: "rename-folder"; id: string; from: string; to: string }
	| { op: "delete-folder"; id: string; path: string }
	| {
			op: "pull-filter";
			id: string;
			name: string;
			enabled: boolean;
			sieve: string;
	  }
	| {
			op: "pull-folder";
			id: string;
			path: string;
			type: LiveFolder["type"];
	  }
	| {
			op: "revert-filter";
			id: string;
			name: string;
			enabled: boolean;
			sieve: string;
	  };

export type PlanNotice =
	| {
			op: "rename-proposal";
			target: "filter" | "folder";
			from: string;
			to: string;
			reason: string;
	  }
	| {
			op: "drift";
			target: "filter" | "folder";
			id: string;
			name: string;
			detail: string;
	  }
	| {
			op: "delete-withheld";
			target: "filter" | "folder";
			id: string;
			name: string;
	  };

export type SyncPlan = {
	actions: PlanAction[];
	notices: PlanNotice[];
};

export type SyncPlanInput = {
	desiredFilters: DesiredFilter[];
	desiredFolders: DesiredFolder[];
	liveFilters: LiveFilter[];
	liveFolders: LiveFolder[];
	observedFilters?: LiveFilter[];
	observedFolders?: LiveFolder[];
	naming: NamingPolicy;
	pull?: string[];
	revert?: string[];
	approveDelete?: string[];
};

type FilterState = {
	name: string;
	enabled: boolean;
	sieve: string;
};

export function buildSyncPlan(input: SyncPlanInput): SyncPlan {
	const liveFilters = orderedFilters(input.liveFilters);
	const liveFolders = input.liveFolders.map(normalizeLiveFolder);
	const desiredFilters = input.desiredFilters;
	const desiredFolders = input.desiredFolders.map(normalizeDesiredFolder);
	const observedFilters = new Map(
		(input.observedFilters ?? []).map((filter) => [filter.id, filter]),
	);
	const observedFolders = new Map(
		(input.observedFolders ?? []).map((folder) => [
			folder.id,
			normalizeLiveFolder(folder),
		]),
	);
	const pull = input.pull ?? [];
	const revert = input.revert ?? [];
	const approveDelete = input.approveDelete ?? [];
	const actions: PlanAction[] = [];
	const notices: PlanNotice[] = [];
	const driftSelectors = new Set<string>();
	const matchedLiveIds = new Set<string>();
	const liveById = new Map(liveFilters.map((filter) => [filter.id, filter]));
	const liveNameCounts = countNames(liveFilters.map((filter) => filter.name));

	for (const desired of desiredFilters) {
		const live = matchLiveFilter(
			desired,
			liveFilters,
			liveById,
			liveNameCounts,
			matchedLiveIds,
		);
		if (!live) {
			actions.push({
				op: "create-filter",
				name: desired.name,
				enabled: desired.enabled,
				sieve: desired.sieve,
			});
			continue;
		}
		matchedLiveIds.add(live.id);
		const decision = classifyMatchedFilter(
			desired,
			live,
			observedFilters.get(live.id),
		);
		if (decision.kind === "sync") continue;
		if (decision.kind === "push") {
			actions.push(decision.action);
			continue;
		}
		rememberDrift(driftSelectors, live.id, live.name);
		resolveFilterDrift(
			decision.detail,
			live,
			desired,
			pull,
			revert,
			actions,
			notices,
		);
	}

	const deleteCandidates: { id: string; name: string }[] = [];
	for (const live of liveFilters) {
		if (matchedLiveIds.has(live.id)) continue;
		if (observedFilters.has(live.id)) {
			deleteCandidates.push({ id: live.id, name: live.name });
			continue;
		}
		rememberDrift(driftSelectors, live.id, live.name);
		notices.push({
			op: "drift",
			target: "filter",
			id: live.id,
			name: live.name,
			detail: "Filter is in Proton and not in the declared file",
		});
	}

	const folderDeleteCandidates: { id: string; path: string }[] = [];
	const matchedFolderIds = new Set<string>();
	const folderNameCounts = countNames(liveFolders.map((folder) => folder.path));
	const liveFolderById = new Map(liveFolders.map((folder) => [folder.id, folder]));
	for (const desired of desiredFolders) {
		const live = matchLiveFolder(
			desired,
			liveFolders,
			liveFolderById,
			folderNameCounts,
			matchedFolderIds,
		);
		if (!live) {
			if (desired.type === "system") continue;
			actions.push({
				op: "create-folder",
				path: desired.path,
				type: desired.type,
			});
			continue;
		}
		matchedFolderIds.add(live.id);
		if (live.type === "system") continue;
		const observed = observedFolders.get(live.id);
		if (live.path === desired.path) continue;
		if (
			observed &&
			observed.path === desired.path &&
			observed.path !== live.path
		) {
			rememberDrift(driftSelectors, live.id, live.path);
			resolveFolderDrift(live, desired.path, pull, revert, actions, notices);
			continue;
		}
		if (observed && observed.path !== desired.path && observed.path !== live.path) {
			rememberDrift(driftSelectors, live.id, live.path);
			resolveFolderDrift(live, desired.path, pull, revert, actions, notices);
			continue;
		}
		actions.push({
			op: "rename-folder",
			id: live.id,
			from: live.path,
			to: desired.path,
		});
	}
	for (const live of liveFolders) {
		if (matchedFolderIds.has(live.id) || live.type === "system") continue;
		if (observedFolders.has(live.id)) {
			folderDeleteCandidates.push({ id: live.id, path: live.path });
			continue;
		}
		rememberDrift(driftSelectors, live.id, live.path);
		notices.push({
			op: "drift",
			target: "folder",
			id: live.id,
			name: live.path,
			detail: "Folder is in Proton and not in the declared file",
		});
	}

	assertKnownSelectors("pull", pull, driftSelectors);
	assertKnownSelectors("revert", revert, driftSelectors);
	const deleteSelectors = new Set<string>();
	for (const candidate of deleteCandidates) {
		deleteSelectors.add(candidate.id);
		deleteSelectors.add(candidate.name);
	}
	for (const candidate of folderDeleteCandidates) {
		deleteSelectors.add(candidate.id);
		deleteSelectors.add(candidate.path);
	}
	for (const notice of notices) {
		if (notice.op !== "drift") continue;
		if (!matchesSelector(revert, notice.id, notice.name)) continue;
		if (!notice.detail.includes("not in the declared file")) continue;
		deleteSelectors.add(notice.id);
		deleteSelectors.add(notice.name);
	}
	assertKnownSelectors("approve-delete", approveDelete, deleteSelectors);

	for (const candidate of deleteCandidates) {
		pushDelete(
			"filter",
			candidate.id,
			candidate.name,
			approveDelete,
			actions,
			notices,
		);
	}
	for (const candidate of folderDeleteCandidates) {
		pushDelete(
			"folder",
			candidate.id,
			candidate.path,
			approveDelete,
			actions,
			notices,
		);
	}
	resolveAddedDrift(
		notices,
		liveFilters,
		liveFolders,
		pull,
		revert,
		approveDelete,
		actions,
	);

	const liveNames = liveFilters.map((filter) => filter.name);
	const desiredNames = desiredFilters.map((filter) => filter.name);
	for (const action of actions) {
		if (action.op === "pull-filter" && !desiredNames.includes(action.name)) {
			desiredNames.push(action.name);
		}
	}
	if (!sameList(liveNames, desiredNames)) {
		actions.push({ op: "reorder-filters", names: [...desiredNames] });
	}

	for (const desired of desiredFilters) {
		const suggestion = suggestFilterRename(desired.name, {
			sieve: desired.sieve,
			folderPaths: desiredFolders.map((folder) => folder.path),
		});
		if (!suggestion || suggestion.to === desired.name) continue;
		notices.push({
			op: "rename-proposal",
			target: "filter",
			from: desired.name,
			to: suggestion.to,
			reason: suggestion.reason,
		});
	}
	for (const desired of desiredFolders) {
		if (desired.type === "system") continue;
		const suggestion = suggestFolderPath(desired.path, input.naming);
		if (!suggestion || suggestion.to === desired.path) continue;
		notices.push({
			op: "rename-proposal",
			target: "folder",
			from: desired.path,
			to: suggestion.to,
			reason: suggestion.reason,
		});
	}

	return { actions, notices };
}

export function planHash(plan: SyncPlan): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(plan)))
		.digest("hex");
}

export function orderedFilters<T extends { sequence?: number }>(filters: T[]): T[] {
	if (
		filters.length === 0 ||
		filters.some((filter) => typeof filter.sequence !== "number")
	) {
		return [...filters];
	}
	return [...filters].sort(
		(left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
	);
}

export function folderCreateOrder<T extends { path: string }>(folders: T[]): T[] {
	return [...folders].sort(
		(left, right) =>
			pathDepth(left.path) - pathDepth(right.path) ||
			left.path.localeCompare(right.path),
	);
}

export function folderDeleteOrder<T extends { path: string }>(folders: T[]): T[] {
	return folderCreateOrder(folders).reverse();
}

export function assertApprovedDeletes(
	actions: PlanAction[],
	approved: string[],
): void {
	for (const action of actions) {
		if (action.op !== "delete-filter" && action.op !== "delete-folder") {
			continue;
		}
		const label = action.op === "delete-filter" ? action.name : action.path;
		if (!approved.includes(action.id) && !approved.includes(label)) {
			throw new Error(`Refusing to delete ${label} without per-item approval`);
		}
	}
}

export function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter((entry) => entry[1] !== undefined)
			.sort((left, right) => left[0].localeCompare(right[0]));
		return Object.fromEntries(
			entries.map(([key, entry]) => [key, canonicalize(entry)]),
		);
	}
	return value;
}

function classifyMatchedFilter(
	desired: DesiredFilter,
	live: LiveFilter,
	observed: LiveFilter | undefined,
):
	| { kind: "sync" }
	| { kind: "push"; action: PlanAction }
	| { kind: "drift"; detail: string } {
	const desiredState = stateOf(desired.name, desired.enabled, desired.sieve);
	const liveState = stateOf(live.name, live.enabled, live.sieve);
	if (sameState(desiredState, liveState)) return { kind: "sync" };
	if (!observed) return { kind: "push", action: updateAction(live, desired) };
	const observedState = stateOf(observed.name, observed.enabled, observed.sieve);
	if (
		sameState(desiredState, observedState) &&
		!sameState(liveState, observedState)
	) {
		return {
			kind: "drift",
			detail: "Proton changed this filter after the last import or sync",
		};
	}
	if (
		!sameState(desiredState, observedState) &&
		!sameState(liveState, observedState)
	) {
		return {
			kind: "drift",
			detail: "Both the declared file and Proton changed this filter",
		};
	}
	return { kind: "push", action: updateAction(live, desired) };
}

function updateAction(live: LiveFilter, desired: DesiredFilter): PlanAction {
	const changes: Array<"name" | "sieve" | "enabled"> = [];
	if (live.name !== desired.name) changes.push("name");
	if (normalizeSieve(live.sieve) !== normalizeSieve(desired.sieve)) {
		changes.push("sieve");
	}
	if (live.enabled !== desired.enabled) changes.push("enabled");
	return {
		op: "update-filter",
		id: live.id,
		fromName: live.name,
		name: desired.name,
		enabled: desired.enabled,
		sieve: desired.sieve,
		changes,
	};
}

function resolveFilterDrift(
	detail: string,
	live: LiveFilter,
	desired: DesiredFilter,
	pull: string[],
	revert: string[],
	actions: PlanAction[],
	notices: PlanNotice[],
): void {
	const selected = matchesSelector(pull, live.id, live.name);
	const restore = matchesSelector(revert, live.id, live.name);
	if (selected && restore) {
		throw new Error(
			`Choose pull or revert for ${live.name}, not both`,
		);
	}
	if (selected) {
		actions.push({
			op: "pull-filter",
			id: live.id,
			name: live.name,
			enabled: live.enabled,
			sieve: live.sieve,
		});
		return;
	}
	if (restore) {
		actions.push({
			op: "revert-filter",
			id: live.id,
			name: desired.name,
			enabled: desired.enabled,
			sieve: desired.sieve,
		});
		return;
	}
	notices.push({
		op: "drift",
		target: "filter",
		id: live.id,
		name: live.name,
		detail,
	});
}

function resolveFolderDrift(
	live: LiveFolder,
	desiredPath: string,
	pull: string[],
	revert: string[],
	actions: PlanAction[],
	notices: PlanNotice[],
): void {
	const selected = matchesSelector(pull, live.id, live.path);
	const restore = matchesSelector(revert, live.id, live.path);
	if (selected && restore) {
		throw new Error(`Choose pull or revert for ${live.path}, not both`);
	}
	if (selected) {
		actions.push({
			op: "pull-folder",
			id: live.id,
			path: live.path,
			type: live.type,
		});
		return;
	}
	if (restore) {
		actions.push({
			op: "rename-folder",
			id: live.id,
			from: live.path,
			to: desiredPath,
		});
		return;
	}
	notices.push({
		op: "drift",
		target: "folder",
		id: live.id,
		name: live.path,
		detail: "Proton changed this folder after the last import or sync",
	});
}

function resolveAddedDrift(
	notices: PlanNotice[],
	liveFilters: LiveFilter[],
	liveFolders: LiveFolder[],
	pull: string[],
	revert: string[],
	approveDelete: string[],
	actions: PlanAction[],
): void {
	for (let index = notices.length - 1; index >= 0; index -= 1) {
		const notice = notices[index];
		if (!notice || notice.op !== "drift") continue;
		if (!notice.detail.includes("not in the declared file")) continue;
		const selected = matchesSelector(pull, notice.id, notice.name);
		const restore = matchesSelector(revert, notice.id, notice.name);
		if (selected && restore) {
			throw new Error(`Choose pull or revert for ${notice.name}, not both`);
		}
		if (selected) {
			notices.splice(index, 1);
			if (notice.target === "filter") {
				const live = liveFilters.find((filter) => filter.id === notice.id);
				if (!live) {
					throw new Error(`Drifted filter disappeared: ${notice.id}`);
				}
				actions.push({
					op: "pull-filter",
					id: live.id,
					name: live.name,
					enabled: live.enabled,
					sieve: live.sieve,
				});
			} else {
				const live = liveFolders.find((folder) => folder.id === notice.id);
				if (!live) {
					throw new Error(`Drifted folder disappeared: ${notice.id}`);
				}
				actions.push({
					op: "pull-folder",
					id: live.id,
					path: live.path,
					type: live.type,
				});
			}
			continue;
		}
		if (!restore || !matchesSelector(approveDelete, notice.id, notice.name)) {
			continue;
		}
		notices.splice(index, 1);
		if (notice.target === "filter") {
			actions.push({ op: "delete-filter", id: notice.id, name: notice.name });
		} else {
			actions.push({ op: "delete-folder", id: notice.id, path: notice.name });
		}
	}
}

function rememberDrift(known: Set<string>, id: string, name: string): void {
	known.add(id);
	known.add(name);
}

function pushDelete(
	target: "filter" | "folder",
	id: string,
	name: string,
	approved: string[],
	actions: PlanAction[],
	notices: PlanNotice[],
): void {
	if (matchesSelector(approved, id, name)) {
		if (target === "filter") {
			actions.push({ op: "delete-filter", id, name });
		} else {
			actions.push({ op: "delete-folder", id, path: name });
		}
		return;
	}
	notices.push({ op: "delete-withheld", target, id, name });
}

function matchLiveFilter(
	desired: DesiredFilter,
	liveFilters: LiveFilter[],
	liveById: Map<string, LiveFilter>,
	nameCounts: Map<string, number>,
	matched: Set<string>,
): LiveFilter | undefined {
	if (desired.protonId) {
		const byId = liveById.get(desired.protonId);
		if (byId && !matched.has(byId.id)) return byId;
	}
	if ((nameCounts.get(desired.name) ?? 0) !== 1) return undefined;
	return liveFilters.find(
		(filter) => filter.name === desired.name && !matched.has(filter.id),
	);
}

function matchLiveFolder(
	desired: DesiredFolder,
	liveFolders: LiveFolder[],
	liveById: Map<string, LiveFolder>,
	pathCounts: Map<string, number>,
	matched: Set<string>,
): LiveFolder | undefined {
	if (desired.protonId) {
		const byId = liveById.get(desired.protonId);
		if (byId && !matched.has(byId.id)) return byId;
	}
	if ((pathCounts.get(desired.path) ?? 0) !== 1) return undefined;
	return liveFolders.find(
		(folder) => folder.path === desired.path && !matched.has(folder.id),
	);
}

function stateOf(name: string, enabled: boolean, sieve: string): FilterState {
	return { name, enabled, sieve: normalizeSieve(sieve) };
}

function sameState(left: FilterState, right: FilterState): boolean {
	return (
		left.name === right.name &&
		left.enabled === right.enabled &&
		left.sieve === right.sieve
	);
}

function countNames(names: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return counts;
}

function matchesSelector(
	selectors: string[],
	id: string,
	name: string,
): boolean {
	return selectors.includes(id) || selectors.includes(name);
}

function assertKnownSelectors(
	kind: string,
	selectors: string[],
	known: Set<string>,
): void {
	if (selectors.length === 0) return;
	if (known.size === 0 && selectors.length > 0) {
		throw new Error(`Unknown ${kind} target: ${selectors[0]}`);
	}
	for (const selector of selectors) {
		if (!known.has(selector)) throw new Error(`Unknown ${kind} target: ${selector}`);
	}
}

function sameList(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function normalizeLiveFolder(folder: LiveFolder): LiveFolder {
	return { ...folder, path: cleanPath(folder.path || folder.name) };
}

function normalizeDesiredFolder(folder: DesiredFolder): DesiredFolder {
	return { ...folder, path: cleanPath(folder.path) };
}

function cleanPath(path: string): string {
	return path
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");
}

function pathDepth(path: string): number {
	return cleanPath(path).split("/").filter(Boolean).length;
}
