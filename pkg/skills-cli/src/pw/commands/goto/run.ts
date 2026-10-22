import type { DaemonHandler } from "../../core/spec";
import { normalizeUrl } from "../../core/url";

const goto: DaemonHandler = async (ctx, args) => {
	const url = normalizeUrl(args.positionals[0] as string);
	await ctx.page().goto(url, { waitUntil: "load" });
	return { code: `await page.goto(${JSON.stringify(url)});`, snapshot: true };
};

export default goto;
