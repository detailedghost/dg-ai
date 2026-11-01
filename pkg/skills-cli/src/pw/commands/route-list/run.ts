import { describeRoute } from "../../core/routes";
import type { DaemonHandler } from "../../core/spec";

const routeList: DaemonHandler = async (ctx) => ({
	result:
		ctx.state.routes.length === 0
			? "No active routes"
			: ctx.state.routes.map(describeRoute).join("\n"),
});

export default routeList;
