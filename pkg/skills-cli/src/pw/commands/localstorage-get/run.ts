import type { DaemonHandler } from "../../core/spec";
import { storageGet } from "../../core/webstorage";

const localstorageGet: DaemonHandler = async (ctx, args) => {
	const key = args.positionals[0] as string;
	const value = await storageGet(ctx.page(), "localStorage", key);
	return {
		result: value === null ? `Key '${key}' not found in localStorage` : value,
		code: `await page.evaluate(() => localStorage.getItem(${JSON.stringify(key)}));`,
	};
};

export default localstorageGet;
