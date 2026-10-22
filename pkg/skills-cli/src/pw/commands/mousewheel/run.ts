import { numberArg } from "../../core/numbers";
import type { DaemonHandler } from "../../core/spec";

const mousewheel: DaemonHandler = async (ctx, args) => {
	const dx = numberArg(args.positionals[0] as string, "dx");
	const dy = numberArg(args.positionals[1] as string, "dy");
	await ctx.page().mouse.wheel(dx, dy);
	return { code: `await page.mouse.wheel(${dx}, ${dy});`, snapshot: true };
};

export default mousewheel;
