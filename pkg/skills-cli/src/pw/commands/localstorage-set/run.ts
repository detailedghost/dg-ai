import type { DaemonHandler } from "../../core/spec";
import { storageSet } from "../../core/webstorage";

const localstorageSet: DaemonHandler = async (ctx, args) => {
	const [key, value] = args.positionals as [string, string];
	await storageSet(ctx.page(), "localStorage", key, value);
	return {
		code: `await page.evaluate(() => localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}));`,
	};
};

export default localstorageSet;
