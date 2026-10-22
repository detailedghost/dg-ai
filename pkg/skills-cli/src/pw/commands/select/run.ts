import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

const selectCommand: DaemonHandler = async (ctx, args) => {
	const [selector, ...values] = args.positionals as [string, ...string[]];
	const locator = await resolveTarget(ctx.page(), selector);
	await locator.selectOption(values);
	return { code: `await ${locatorCode(locator)}.selectOption(${JSON.stringify(values)});`, snapshot: true };
};

export default selectCommand;
