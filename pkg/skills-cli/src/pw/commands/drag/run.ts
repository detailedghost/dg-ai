import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

const drag: DaemonHandler = async (ctx, args) => {
	const page = ctx.page();
	const start = await resolveTarget(page, args.positionals[0] as string);
	const end = await resolveTarget(page, args.positionals[1] as string);
	await start.dragTo(end);
	return { code: `await ${locatorCode(start)}.dragTo(${locatorCode(end)});`, snapshot: true };
};

export default drag;
