import type { Page } from "playwright-core";
import type { DaemonHandler } from "../../core/spec";
import { listTabs, tabIndex } from "../../core/tabs";

const tabClose: DaemonHandler = async (ctx, args) => {
	const pages = ctx.context.pages();
	const current = ctx.page();
	const requested = args.positionals[0];
	const index =
		requested === undefined
			? pages.indexOf(current)
			: tabIndex(requested, pages.length);
	const closing = pages[index] as Page;
	await closing.close();
	const remaining = ctx.context.pages();
	if (closing === current && remaining.length > 0)
		ctx.selectTab(Math.max(0, index - 1));
	return {
		result: await listTabs(ctx),
		code:
			requested === undefined
				? "await page.close();"
				: `await page.context().pages()[${index}].close();`,
		snapshot: remaining.length > 0 ? true : undefined,
	};
};

export default tabClose;
