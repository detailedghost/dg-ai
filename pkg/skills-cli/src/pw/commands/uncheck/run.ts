import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

const uncheck: DaemonHandler = async (ctx, args) => {
	const locator = await resolveTarget(ctx.page(), args.positionals[0] as string);
	await locator.uncheck();
	return { code: `await ${locatorCode(locator)}.uncheck();`, snapshot: true };
};

export default uncheck;
