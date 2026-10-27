import {
	declaredFiltersPath,
	readDeclaredFiltersIfExists,
} from "../features/filter-policy/store";
import type {
	DeclaredFilter,
	DeclaredFiltersFile,
} from "../features/filter-policy/schema";
import type { ProtonFilter } from "../protonmail/types";

export function findDeclaredFilter(
	declared: DeclaredFiltersFile | undefined,
	filter: { id: string; name: string },
): DeclaredFilter | undefined {
	return (
		declared?.filters.find((item) => item.protonId === filter.id) ??
		declared?.filters.find((item) => !item.protonId && item.name === filter.name)
	);
}

/** Swaps live filters for their declared entries; drops live filters removed from the declared file. */
export function overlayDeclaredFilters<T extends ProtonFilter>(
	filters: T[],
	declared: DeclaredFiltersFile | undefined,
): T[] {
	if (!declared) {
		return filters;
	}
	const observed = declared.observed?.filters ?? [];
	return filters.flatMap((filter) => {
		const entry = findDeclaredFilter(declared, filter);
		if (entry) {
			return [
				{
					...filter,
					name: entry.name,
					enabled: entry.enabled,
					conditions: [entry.sieve],
					actions: [],
				},
			];
		}
		const pendingRemoval = observed.some((item) => item.id === filter.id);
		return pendingRemoval ? [] : [filter];
	});
}

export async function readDeclaredOverlay<T extends ProtonFilter>(
	dir: string,
	filters: T[],
): Promise<T[]> {
	return overlayDeclaredFilters(
		filters,
		await readDeclaredFiltersIfExists(declaredFiltersPath(dir)),
	);
}
