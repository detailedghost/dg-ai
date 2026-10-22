import type { Page } from "playwright-core";
import type { DaemonHandler } from "../../core/spec";
import { listTabs, tabIndex } from "../../core/tabs";

const tabSelect: DaemonHandler = async (ctx, args) => {
	const pages = ctx.context.pages();
	const index = tabIndex(args.positionals[0] as string, pages.length);
	ctx.selectTab(index);
	await (pages[index] as Page).bringToFront();
	return {
		result: await listTabs(ctx),
		code: `await page.context().pages()[${index}].bringToFront();`,
		snapshot: true,
	};
};

export default tabSelect;
