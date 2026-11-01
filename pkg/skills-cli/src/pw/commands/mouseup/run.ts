import { parseButton } from "../../core/pointer";
import type { DaemonHandler } from "../../core/spec";

const mouseup: DaemonHandler = async (ctx, args) => {
	const button = parseButton(args.positionals[0]);
	await ctx.page().mouse.up({ button });
	return {
		code: `await page.mouse.up(${button === "left" ? "" : JSON.stringify({ button })});`,
		snapshot: true,
	};
};

export default mouseup;
