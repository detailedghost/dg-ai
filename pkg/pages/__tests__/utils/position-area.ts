import type { PositionArea } from "../../src/runtime";

export function makePositionArea(initial: Record<string, unknown> = {}): {
	area: PositionArea;
	data: Record<string, unknown>;
} {
	const data: Record<string, unknown> = { ...initial };
	return {
		data,
		area: {
			get: async () => ({ ...data }),
			set: async (items) => {
				Object.assign(data, items);
			},
			remove: async (keys) => {
				for (const key of keys) delete data[key];
			},
		},
	};
}
