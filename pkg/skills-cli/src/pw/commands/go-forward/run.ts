import type { DaemonHandler } from "../../core/spec";

const goForward: DaemonHandler = async (ctx) => {
	await ctx.page().goForward({ waitUntil: "load" });
	return { code: "await page.goForward();", snapshot: true };
};

export default goForward;
