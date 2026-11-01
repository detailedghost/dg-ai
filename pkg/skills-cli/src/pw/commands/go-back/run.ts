import type { DaemonHandler } from "../../core/spec";

const goBack: DaemonHandler = async (ctx) => {
	await ctx.page().goBack({ waitUntil: "load" });
	return { code: "await page.goBack();", snapshot: true };
};

export default goBack;
