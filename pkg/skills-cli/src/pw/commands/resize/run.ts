import { UsageError } from "../../core/args";
import type { DaemonHandler } from "../../core/spec";

const resize: DaemonHandler = async (ctx, args) => {
	const [width, height] = args.positionals.map((value) => {
		if (!/^\d+$/.test(value) || Number(value) === 0)
			throw new UsageError(`Invalid size '${value}': use a positive integer`);
		return Number(value);
	}) as [number, number];
	await ctx.page().setViewportSize({ width, height });
	return {
		code: `await page.setViewportSize({ width: ${width}, height: ${height} });`,
		snapshot: true,
	};
};

export default resize;
