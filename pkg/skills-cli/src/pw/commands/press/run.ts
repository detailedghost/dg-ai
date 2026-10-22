import { normalizeKey } from "../../core/keys";
import type { DaemonHandler } from "../../core/spec";

const press: DaemonHandler = async (ctx, args) => {
	const key = normalizeKey(args.positionals[0] as string);
	await ctx.page().keyboard.press(key);
	return { code: `await page.keyboard.press(${JSON.stringify(key)});`, snapshot: true };
};

export default press;
