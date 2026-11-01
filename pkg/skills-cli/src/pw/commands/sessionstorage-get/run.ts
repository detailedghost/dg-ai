import type { DaemonHandler } from "../../core/spec";
import { storageGet } from "../../core/webstorage";

const sessionstorageGet: DaemonHandler = async (ctx, args) => {
	const key = args.positionals[0] as string;
	const value = await storageGet(ctx.page(), "sessionStorage", key);
	return {
		result: value === null ? `Key '${key}' not found in sessionStorage` : value,
		code: `await page.evaluate(() => sessionStorage.getItem(${JSON.stringify(key)}));`,
	};
};

export default sessionstorageGet;
