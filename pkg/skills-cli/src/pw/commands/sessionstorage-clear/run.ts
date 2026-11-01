import type { DaemonHandler } from "../../core/spec";
import { storageClear } from "../../core/webstorage";

const sessionstorageClear: DaemonHandler = async (ctx) => {
	await storageClear(ctx.page(), "sessionStorage");
	return { code: "await page.evaluate(() => sessionStorage.clear());" };
};

export default sessionstorageClear;
