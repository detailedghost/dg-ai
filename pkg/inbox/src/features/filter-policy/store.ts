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
import type { LiveFilter, LiveFolder } from "./plan";

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

export function seedDeclaredFromLive(input: {
	filters: Array<{
		id: string;
		name: string;
		enabled: boolean;
		conditions?: string[];
		actions?: string[];
		sieve?: string;
	}>;
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
	file.filters = input.filters.map((filter) => ({
		name: filter.name,
		enabled: filter.enabled,
		sieve: filter.sieve ?? fullSieveOrThrow(filter),
		protonId: filter.id,
	}));
	file.observed = {
		filters: file.filters.map((filter) => ({
			id: filter.protonId ?? filter.name,
			name: filter.name,
			enabled: filter.enabled,
			sieve: filter.sieve,
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
	filters: Array<{
		id: string;
		name: string;
		enabled: boolean;
		conditions?: string[];
		actions?: string[];
		sieve?: string;
	}>;
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

export function upsertDeclaredFilter(
	file: DeclaredFiltersFile,
	filter: {
		name: string;
		enabled: boolean;
		sieve: string;
		protonId?: string;
	},
): void {
	const index = file.filters.findIndex(
		(item) =>
			(filter.protonId !== undefined && item.protonId === filter.protonId) ||
			item.name === filter.name,
	);
	if (index >= 0) {
		const current = file.filters[index];
		if (!current) return;
		file.filters[index] = { ...current, ...filter };
		return;
	}
	file.filters.push(filter);
}

export function removeDeclaredFilters(
	file: DeclaredFiltersFile,
	ids: string[],
): void {
	const drop = new Set(ids);
	file.filters = file.filters.filter(
		(filter) => !drop.has(filter.protonId ?? "") && !drop.has(filter.name),
	);
}

export function upsertDeclaredFolder(
	file: DeclaredFiltersFile,
	folder: DeclaredFolder,
): void {
	const index = file.folders.findIndex(
		(item) =>
			item.path === folder.path ||
			(folder.protonId !== undefined && item.protonId === folder.protonId),
	);
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
	}>,
	folders: Array<{
		id: string;
		name: string;
		path?: string;
		type?: "folder" | "label" | "system";
	}>,
): void {
	for (const filter of file.filters) {
		const live = filters.find(
			(item) => item.id === filter.protonId || item.name === filter.name,
		);
		if (live) filter.protonId = live.id;
	}
	for (const folder of file.folders) {
		const live = folders.find(
			(item) =>
				item.id === folder.protonId ||
				(item.path?.trim() || item.name) === folder.path,
		);
		if (live) folder.protonId = live.id;
	}
	file.observed = {
		filters: filters.map((filter) => ({
			id: filter.id,
			name: filter.name,
			enabled: filter.enabled,
			sieve: filter.sieve,
		})),
		folders: folders.map((folder) => ({
			id: folder.id,
			path: folder.path?.trim() || folder.name,
			name: folder.name,
			type: folder.type ?? "folder",
		})),
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
