import { numberArg } from "../../core/numbers";
import type { DaemonHandler } from "../../core/spec";

const mousemove: DaemonHandler = async (ctx, args) => {
	const x = numberArg(args.positionals[0] as string, "x");
	const y = numberArg(args.positionals[1] as string, "y");
	await ctx.page().mouse.move(x, y);
	return { code: `await page.mouse.move(${x}, ${y});`, snapshot: true };
};

export default mousemove;
