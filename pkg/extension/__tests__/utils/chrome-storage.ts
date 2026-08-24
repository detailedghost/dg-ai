
import { mock } from "bun:test";

export function stubChromeStorage(
	initial: Record<string, unknown> = {},
): Record<string, unknown> {
	const data: Record<string, unknown> = { ...initial };
	(globalThis as unknown as { chrome: unknown }).chrome = {
		storage: {
			local: {
				get: mock(async (keys?: string | string[] | null) => {
					if (keys === undefined || keys === null) return { ...data };
					const ks = Array.isArray(keys) ? keys : [keys];
					const result: Record<string, unknown> = {};
					for (const k of ks) if (k in data) result[k] = data[k];
					return result;
				}),
				set: mock(async (items: Record<string, unknown>) => {
					Object.assign(data, items);
				}),
				remove: mock(async (keys: string | string[]) => {
					const ks = Array.isArray(keys) ? keys : [keys];
					for (const k of ks) delete data[k];
				}),
			},
		},
	};
	return data;
}
