import type { DaemonHandler } from "../../core/spec";
import { storageDelete } from "../../core/webstorage";

const localstorageDelete: DaemonHandler = async (ctx, args) => {
	const key = args.positionals[0] as string;
	await storageDelete(ctx.page(), "localStorage", key);
	return {
		code: `await page.evaluate(() => localStorage.removeItem(${JSON.stringify(key)}));`,
	};
};

export default localstorageDelete;
