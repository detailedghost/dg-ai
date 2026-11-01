import { readInput } from "../../core/files";
import type { Ctx, DaemonHandler } from "../../core/spec";
import { parseStorageState, type StoredOrigin } from "../../core/states";

async function restoreOrigin(ctx: Ctx, stored: StoredOrigin): Promise<void> {
	const page = await ctx.context.newPage();
	try {
		await page.route(
			(url) => url.origin === stored.origin,
			(route) =>
				route.fulfill({
					contentType: "text/html",
					body: "<!doctype html><title>pw</title>",
				}),
		);
		await page.goto(`${stored.origin}/`);
		await page.evaluate((items) => {
			for (const item of items) localStorage.setItem(item.name, item.value);
		}, stored.localStorage ?? []);
	} finally {
		await page.close();
	}
}

const stateLoad: DaemonHandler = async (ctx, args) => {
	const file = args.positionals[0] as string;
	const state = parseStorageState(await readInput(ctx.clientCwd, file), file);
	const cookies = state.cookies ?? [];
	const origins = (state.origins ?? []).filter((stored) => (stored.localStorage?.length ?? 0) > 0);
	if (cookies.length > 0) await ctx.context.addCookies(cookies);
	const previous = ctx.context.pages().includes(ctx.page()) ? ctx.page() : undefined;
	for (const stored of origins) await restoreOrigin(ctx, stored);
	if (previous) ctx.selectTab(Math.max(0, ctx.context.pages().indexOf(previous)));
	const skipped = (state.origins ?? []).some((stored) => (stored.indexedDB?.length ?? 0) > 0);
	const note = skipped ? " IndexedDB was not restored." : "";
	return {
		result: `Loaded ${cookies.length} cookies, ${origins.length} origins with localStorage.${note}`,
		code: `await page.context().addCookies(${JSON.stringify(file)}.cookies);`,
		snapshot: true,
	};
};

export default stateLoad;
