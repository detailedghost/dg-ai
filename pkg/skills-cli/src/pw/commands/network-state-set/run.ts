import { UsageError } from "../../core/args";
import type { DaemonHandler } from "../../core/spec";

const networkStateSet: DaemonHandler = async (ctx, args) => {
	const state = args.positionals[0] as string;
	if (state !== "online" && state !== "offline") {
		throw new UsageError(`Invalid state '${state}': use online or offline`);
	}
	await ctx.context.setOffline(state === "offline");
	return { result: `Network is now ${state}`, code: `await page.context().setOffline(${state === "offline"});` };
};

export default networkStateSet;
