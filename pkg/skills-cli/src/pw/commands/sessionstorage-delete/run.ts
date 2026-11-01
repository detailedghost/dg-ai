import type { DaemonHandler } from "../../core/spec";
import { storageDelete } from "../../core/webstorage";

const sessionstorageDelete: DaemonHandler = async (ctx, args) => {
	const key = args.positionals[0] as string;
	await storageDelete(ctx.page(), "sessionStorage", key);
	return {
		code: `await page.evaluate(() => sessionStorage.removeItem(${JSON.stringify(key)}));`,
	};
};

export default sessionstorageDelete;
