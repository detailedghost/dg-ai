import type { DaemonHandler } from "../../core/spec";

const reloadCommand: DaemonHandler = async (ctx) => {
	await ctx.page().reload({ waitUntil: "load" });
	return { code: "await page.reload();", snapshot: true };
};

export default reloadCommand;
