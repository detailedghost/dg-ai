import type { DaemonHandler } from "../../core/spec";

const tracingStart: DaemonHandler = async (ctx) => {
	if (ctx.state.tracing) throw new Error("Tracing is already started. Run: pw tracing-stop");
	await ctx.context.tracing.start({ screenshots: true, snapshots: true });
	ctx.state.tracing = true;
	return {
		result: "Trace recording started",
		code: "await page.context().tracing.start({ screenshots: true, snapshots: true });",
	};
};

export default tracingStart;
