import type { DaemonHandler } from "../../core/spec";

const cookieClear: DaemonHandler = async (ctx) => {
	await ctx.context.clearCookies();
	return { code: "await page.context().clearCookies();" };
};

export default cookieClear;
