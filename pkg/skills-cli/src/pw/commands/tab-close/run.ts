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
	const rebind = closing === current && remaining.length > 0;
	const next = Math.max(0, index - 1);
	if (rebind) ctx.selectTab(next);
	const close =
		requested === undefined
			? "await page.close();"
			: `await page.context().pages()[${index}].close();`;
	return {
		result: await listTabs(ctx),
		code: rebind ? `${close}\npage = page.context().pages()[${next}];` : close,
		snapshot: remaining.length > 0 ? true : undefined,
	};
};

export default tabClose;
