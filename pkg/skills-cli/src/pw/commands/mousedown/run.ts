import { parseButton } from "../../core/pointer";
import type { DaemonHandler } from "../../core/spec";

const mousedown: DaemonHandler = async (ctx, args) => {
	const button = parseButton(args.positionals[0]);
	await ctx.page().mouse.down({ button });
	return { code: `await page.mouse.down(${button === "left" ? "" : JSON.stringify({ button })});`, snapshot: true };
};

export default mousedown;
