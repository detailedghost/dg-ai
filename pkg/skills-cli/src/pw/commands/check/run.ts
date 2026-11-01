import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

const check: DaemonHandler = async (ctx, args) => {
	const locator = await resolveTarget(
		ctx.page(),
		args.positionals[0] as string,
	);
	await locator.check();
	return { code: `await ${locatorCode(locator)}.check();`, snapshot: true };
};

export default check;
