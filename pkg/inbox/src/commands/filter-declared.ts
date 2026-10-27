import {
	declaredFiltersPath,
	declaredOnlyId,
	isDeclaredOnlyId,
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
	live: Array<{ name: string }>,
): DeclaredFilter | undefined {
	const byId = declared?.filters.find((item) => item.protonId === filter.id);
	if (byId) return byId;
	const ambiguous = live.filter((item) => item.name === filter.name).length > 1;
	if (ambiguous) return undefined;
	return declared?.filters.find((item) => !item.protonId && item.name === filter.name);
}

export { isDeclaredOnlyId };

/** Staged declared entries with no Proton ID, shaped like live filters. */
export function declaredOnlyFilters(
	filters: Array<{ id: string; name: string }>,
	declared: DeclaredFiltersFile | undefined,
): ProtonFilter[] {
	if (!declared) {
		return [];
	}
	const claimed = new Set(filters.map((filter) => findDeclaredFilter(declared, filter, filters)));
	return declared.filters
		.flatMap((entry, index) =>
			!entry.protonId && !claimed.has(entry) ? [{ entry, index }] : [],
		)
		.map(({ entry, index }) => ({
			id: declaredOnlyId(index),
			name: entry.name,
			enabled: entry.enabled,
			conditions: [entry.sieve],
			actions: [],
		}));
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
		const entry = findDeclaredFilter(declared, filter, filters);
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

export function projectDeclaredFilters<T extends ProtonFilter>(
	filters: T[],
	declared: DeclaredFiltersFile | undefined,
): Array<T | ProtonFilter> {
	return [
		...overlayDeclaredFilters(filters, declared),
		...declaredOnlyFilters(filters, declared),
	];
}

export async function readDeclaredWithUnsynced<T extends ProtonFilter>(
	dir: string,
	filters: T[],
): Promise<Array<T | ProtonFilter>> {
	return projectDeclaredFilters(
		filters,
		await readDeclaredFiltersIfExists(declaredFiltersPath(dir)),
	);
}
