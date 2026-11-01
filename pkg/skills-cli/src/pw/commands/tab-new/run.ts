import type { DaemonHandler } from "../../core/spec";
import { listTabs } from "../../core/tabs";
import { normalizeUrl } from "../../core/url";

const tabNew: DaemonHandler = async (ctx, args) => {
	const page = await ctx.context.newPage();
	const index = ctx.context.pages().indexOf(page);
	if (index >= 0) ctx.selectTab(index);
	const url = args.positionals[0];
	if (url) await page.goto(normalizeUrl(url), { waitUntil: "load" });
	return {
		result: await listTabs(ctx),
		code: url
			? `const page = await page.context().newPage();\nawait page.goto(${JSON.stringify(normalizeUrl(url))});`
			: "await page.context().newPage();",
		snapshot: true,
	};
};

export default tabNew;
