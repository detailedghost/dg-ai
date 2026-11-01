import type { DaemonHandler } from "../../core/spec";
import { formatEntries, storageList } from "../../core/webstorage";

const sessionstorageList: DaemonHandler = async (ctx) => ({
	result: formatEntries("sessionStorage", await storageList(ctx.page(), "sessionStorage")),
	code: "await page.evaluate(() => ({ ...sessionStorage }));",
});

export default sessionstorageList;
