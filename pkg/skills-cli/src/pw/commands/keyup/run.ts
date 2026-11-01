import { normalizeKey } from "../../core/keys";
import type { DaemonHandler } from "../../core/spec";

const keyup: DaemonHandler = async (ctx, args) => {
	const key = normalizeKey(args.positionals[0] as string);
	await ctx.page().keyboard.up(key);
	return {
		code: `await page.keyboard.up(${JSON.stringify(key)});`,
		snapshot: true,
	};
};

export default keyup;
