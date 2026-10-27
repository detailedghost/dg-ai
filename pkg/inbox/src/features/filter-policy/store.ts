import { join } from "node:path";
import { readJsonFile, readJsonFileIfExists, writeJsonFile } from "../../utils/json";
import { fullSieveOrThrow } from "./parse";
import {
	emptyDeclaredFilters,
	parseDeclaredFilters,
	type DeclaredFiltersFile,
	type DeclaredFolder,
	type DeclaredPolicy,
} from "./schema";
import { orderedFilters, type LiveFilter, type LiveFolder } from "./plan";

export function declaredFiltersPath(dir: string): string {
	return join(dir, "declared-filters.json");
}

export async function readDeclaredFilters(
	path: string,
): Promise<DeclaredFiltersFile> {
	return parseDeclaredFilters(await readJsonFile(path));
}

export async function readDeclaredFiltersIfExists(
	path: string,
): Promise<DeclaredFiltersFile | undefined> {
	const value = await readJsonFileIfExists<unknown>(path);
	if (value === undefined) return undefined;
	return parseDeclaredFilters(value);
}

export async function writeDeclaredFilters(
	path: string,
	file: DeclaredFiltersFile,
): Promise<void> {
	await writeJsonFile(path, parseDeclaredFilters(file));
}

type LiveFilterInput = {
	id: string;
	name: string;
	enabled: boolean;
	conditions?: string[];
	actions?: string[];
	sieve?: string;
	sequence?: number;
};

export function seedDeclaredFromLive(input: {
	filters: LiveFilterInput[];
	folders: Array<{
		id: string;
		name: string;
		path?: string;
		type?: "folder" | "label" | "system";
	}>;
	policy?: DeclaredPolicy;
}): DeclaredFiltersFile {
	const file = emptyDeclaredFilters();
	if (input.policy) file.policy = input.policy;
	file.folders = input.folders.map((folder) => toDeclaredFolder(folder));
	const ordered = orderedFilters(input.filters);
	file.filters = ordered.map((filter) => ({
		name: filter.name,
		enabled: filter.enabled,
		sieve: filter.sieve ?? fullSieveOrThrow(filter),
		protonId: filter.id,
	}));
	file.observed = {
		filters: ordered.map((filter, index) => ({
			id: filter.id,
			name: filter.name,
			enabled: filter.enabled,
			sieve: file.filters[index]?.sieve ?? "",
			...(filter.sequence !== undefined ? { sequence: filter.sequence } : {}),
		})),
		folders: file.folders.flatMap((folder) => {
			if (!folder.protonId) return [];
			return [
				{
					id: folder.protonId,
					path: folder.path,
					name: folder.path.split("/").at(-1) ?? folder.path,
					type: folder.type,
				},
			];
		}),
	};
	return parseDeclaredFilters(file);
}

export async function editDeclaredFilters(input: {
	path: string;
	filters: LiveFilterInput[];
	folders: Array<{
		id: string;
		name: string;
		path?: string;
		type?: "folder" | "label" | "system";
	}>;
	edit: (file: DeclaredFiltersFile) => void;
}): Promise<DeclaredFiltersFile> {
	const existing = await readDeclaredFiltersIfExists(input.path);
	const file =
		existing ??
		seedDeclaredFromLive({
			filters: input.filters,
			folders: input.folders,
		});
	input.edit(file);
	await writeDeclaredFilters(input.path, file);
	return file;
}

const declaredOnlyPrefix = "declared:";

export function declaredOnlyId(index: number): string {
	return `${declaredOnlyPrefix}${index}`;
}

export function isDeclaredOnlyId(id: string): boolean {
	return id.startsWith(declaredOnlyPrefix);
}

function declaredOnlyIndex(id: string): number | undefined {
	if (!isDeclaredOnlyId(id)) return undefined;
	const index = Number(id.slice(declaredOnlyPrefix.length));
	return Number.isInteger(index) && index >= 0 ? index : undefined;
}

export function upsertDeclaredFilter(
	file: DeclaredFiltersFile,
	filter: {
		name: string;
		enabled: boolean;
		sieve: string;
		protonId?: string;
	},
	localId?: string,
): number {
	const local = localId === undefined ? undefined : declaredOnlyIndex(localId);
	const byId =
		filter.protonId === undefined
			? -1
			: file.filters.findIndex((item) => item.protonId === filter.protonId);
	const index =
		local !== undefined && file.filters[local] && !file.filters[local].protonId
			? local
			: byId >= 0
				? byId
				: file.filters.findIndex(
						(item) => item.protonId === undefined && item.name === filter.name,
					);
	if (index >= 0) {
		const current = file.filters[index];
		if (current) file.filters[index] = { ...current, ...filter };
		return index;
	}
	return file.filters.push(filter) - 1;
}

export function removeDeclaredFilters(
	file: DeclaredFiltersFile,
	ids: string[],
): void {
	const drop = new Set(ids);
	const dropIndexes = new Set(ids.map(declaredOnlyIndex));
	file.filters = file.filters.filter(
		(filter, index) =>
			!drop.has(filter.protonId ?? "") &&
			!(filter.protonId === undefined && dropIndexes.has(index)),
	);
}

export function findDeclaredFolderIndex(
	file: DeclaredFiltersFile,
	folder: { path: string; protonId?: string },
): number {
	if (folder.protonId !== undefined) {
		const byId = file.folders.findIndex(
			(item) => item.protonId === folder.protonId,
		);
		if (byId >= 0) return byId;
	}
	const byPath = file.folders.flatMap((item, index) =>
		item.path === folder.path &&
		(folder.protonId === undefined || item.protonId === undefined)
			? [index]
			: [],
	);
	return byPath.length === 1 ? (byPath[0] ?? -1) : -1;
}

export function upsertDeclaredFolder(
	file: DeclaredFiltersFile,
	folder: DeclaredFolder,
): void {
	const index = findDeclaredFolderIndex(file, folder);
	if (index >= 0) {
		const current = file.folders[index];
		if (!current) return;
		file.folders[index] = { ...current, ...folder };
		return;
	}
	file.folders.push(folder);
}

export function toLiveFilters(
	file: DeclaredFiltersFile,
): { desired: LiveFilter[]; observed: LiveFilter[] } {
	return {
		desired: file.filters.map((filter, index) => ({
			id: filter.protonId ?? `declared-${index}`,
			name: filter.name,
			enabled: filter.enabled,
			sieve: filter.sieve,
		})),
		observed: (file.observed?.filters ?? []).map((filter) => ({
			id: filter.id,
			name: filter.name,
			enabled: filter.enabled,
			sieve: filter.sieve,
			...(filter.sequence !== undefined ? { sequence: filter.sequence } : {}),
		})),
	};
}

export function observeLive(
	file: DeclaredFiltersFile,
	filters: Array<{
		id: string;
		name: string;
		enabled: boolean;
		sieve: string;
		sequence?: number;
	}>,
	folders: Array<{
		id: string;
		name: string;
		path?: string;
		type?: "folder" | "label" | "system";
	}>,
	created: { filters: string[]; folders: string[] } = { filters: [], folders: [] },
): void {
	const liveFilterIds = new Set(filters.map((item) => item.id));
	const claimed = new Set(
		file.filters.flatMap((filter) =>
			filter.protonId && liveFilterIds.has(filter.protonId) ? [filter.protonId] : [],
		),
	);
	for (const filter of file.filters) {
		if (filter.protonId || !created.filters.includes(filter.name)) continue;
		const sameName = filters.filter((item) => item.name === filter.name);
		const [live] = sameName.filter((item) => !claimed.has(item.id));
		if (sameName.length !== 1 || !live) continue;
		filter.protonId = live.id;
		claimed.add(live.id);
	}
	for (const folder of file.folders) {
		if (folder.protonId || !created.folders.includes(folder.path)) continue;
		const samePath = folders.filter(
			(item) => (item.path?.trim() || item.name) === folder.path,
		);
		const [live] = samePath;
		if (samePath.length !== 1 || !live) continue;
		folder.protonId = live.id;
	}
	file.observed = {
		filters: filters.map((filter) => ({
			id: filter.id,
			name: filter.name,
			enabled: filter.enabled,
			sieve: filter.sieve,
			...(filter.sequence !== undefined ? { sequence: filter.sequence } : {}),
		})),
		folders: folders.map((folder) => ({
			id: folder.id,
			path: folder.path?.trim() || folder.name,
			name: folder.name,
			type: folder.type ?? "folder",
		})),
	};
}

export function keepUntouchedBaseline(
	file: DeclaredFiltersFile,
	baseline: DeclaredFiltersFile["observed"],
	touchedIds: Set<string>,
	reorderedIds: Set<string> = new Set(),
): void {
	if (!baseline || !file.observed) return;
	const merge = <T extends { id: string; sequence?: number }>(
		live: T[],
		before: T[],
	): T[] => {
		const prior = new Map(before.map((item) => [item.id, item]));
		const liveIds = new Set(live.map((item) => item.id));
		const kept = live.flatMap((item) => {
			if (touchedIds.has(item.id)) return [item];
			const old = prior.get(item.id);
			if (!old) return [];
			if (!reorderedIds.has(item.id)) return [old];
			return [
				item.sequence === undefined ? old : { ...old, sequence: item.sequence },
			];
		});
		const missing = before.filter(
			(item) => !liveIds.has(item.id) && !touchedIds.has(item.id),
		);
		return [...kept, ...missing];
	};
	file.observed = {
		filters: merge(file.observed.filters, baseline.filters),
		folders: merge(file.observed.folders, baseline.folders),
	};
}

export function toLiveFolders(file: DeclaredFiltersFile): {
	desired: LiveFolder[];
	observed: LiveFolder[];
} {
	return {
		desired: file.folders.map((folder, index) => ({
			id: folder.protonId ?? `declared-folder-${index}`,
			path: folder.path,
			name: folder.path.split("/").at(-1) ?? folder.path,
			type: folder.type,
		})),
		observed: (file.observed?.folders ?? []).map((folder) => ({
			id: folder.id,
			path: folder.path,
			name: folder.name,
			type: folder.type,
		})),
	};
}

function toDeclaredFolder(folder: {
	id: string;
	name: string;
	path?: string;
	type?: "folder" | "label" | "system";
}): DeclaredFolder {
	return {
		path: folder.path?.trim() || folder.name,
		type: folder.type ?? "folder",
		protonId: folder.id,
	};
}
