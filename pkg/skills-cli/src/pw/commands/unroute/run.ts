import { removeRoutes } from "../../core/routes";
import type { DaemonHandler } from "../../core/spec";

const unroute: DaemonHandler = async (ctx, args) => {
	const pattern = args.positionals[0];
	const removed = await removeRoutes(ctx, pattern);
	return {
		result: pattern
			? `Removed ${removed} route(s) for pattern: ${pattern}`
			: `Removed all ${removed} route(s)`,
		code: pattern
			? `await page.context().unroute(${JSON.stringify(pattern)});`
			: "await page.context().unrouteAll();",
	};
};

export default unroute;
