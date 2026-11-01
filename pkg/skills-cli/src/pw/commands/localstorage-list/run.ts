import type { DaemonHandler } from "../../core/spec";
import { formatEntries, storageList } from "../../core/webstorage";

const localstorageList: DaemonHandler = async (ctx) => ({
	result: formatEntries(
		"localStorage",
		await storageList(ctx.page(), "localStorage"),
	),
	code: "await page.evaluate(() => ({ ...localStorage }));",
});

export default localstorageList;
