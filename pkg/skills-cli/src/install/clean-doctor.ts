import type { DoctorCheck } from "../doctor/types";
import { ok, warn } from "../doctor/types";

export const cleanChecks: DoctorCheck[] = [
	{
		id: "leftovers",
		async run(ctx) {
			const { pendingCleanPaths } = await import("./clean");
			const pending = pendingCleanPaths(ctx.paths);
			return pending.length > 0
				? warn(`${pending.length} leftover path(s) from the layout move: ${pending.join(", ")}`, "dg-skills clean")
				: ok("no leftovers from the layout move");
		},
	},
];
