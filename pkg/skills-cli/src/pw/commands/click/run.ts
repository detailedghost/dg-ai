import { stringFlag } from "../../core/args";
import { parseButton, parseModifiers, pointerOptions } from "../../core/pointer";
import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

const click: DaemonHandler = async (ctx, args) => {
	const button = parseButton(args.positionals[1]);
	const modifiers = parseModifiers(stringFlag(args, "modifiers"));
	const locator = await resolveTarget(ctx.page(), args.positionals[0] as string);
	await locator.click({ button, modifiers });
	return { code: `await ${locatorCode(locator)}.click(${pointerOptions(button, modifiers)});`, snapshot: true };
};

export default click;
