import type { DaemonHandler } from "../../core/spec";

const cookieDelete: DaemonHandler = async (ctx, args) => {
	const name = args.positionals[0] as string;
	await ctx.context.clearCookies({ name });
	return { code: `await page.context().clearCookies({ name: ${JSON.stringify(name)} });` };
};

export default cookieDelete;
