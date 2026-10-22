import { normalizeKey } from "../../core/keys";
import type { DaemonHandler } from "../../core/spec";

const keydown: DaemonHandler = async (ctx, args) => {
	const key = normalizeKey(args.positionals[0] as string);
	await ctx.page().keyboard.down(key);
	return { code: `await page.keyboard.down(${JSON.stringify(key)});`, snapshot: true };
};

export default keydown;
