import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

const hover: DaemonHandler = async (ctx, args) => {
	const locator = await resolveTarget(ctx.page(), args.positionals[0] as string);
	await locator.hover();
	return { code: `await ${locatorCode(locator)}.hover();`, snapshot: true };
};

export default hover;
