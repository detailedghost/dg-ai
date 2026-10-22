import type { DaemonHandler } from "../../core/spec";
import { storageSet } from "../../core/webstorage";

const sessionstorageSet: DaemonHandler = async (ctx, args) => {
	const [key, value] = args.positionals as [string, string];
	await storageSet(ctx.page(), "sessionStorage", key, value);
	return {
		code: `await page.evaluate(() => sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}));`,
	};
};

export default sessionstorageSet;
