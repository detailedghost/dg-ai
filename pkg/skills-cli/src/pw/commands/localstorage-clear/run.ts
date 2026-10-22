import type { DaemonHandler } from "../../core/spec";
import { storageClear } from "../../core/webstorage";

const localstorageClear: DaemonHandler = async (ctx) => {
	await storageClear(ctx.page(), "localStorage");
	return { code: "await page.evaluate(() => localStorage.clear());" };
};

export default localstorageClear;
