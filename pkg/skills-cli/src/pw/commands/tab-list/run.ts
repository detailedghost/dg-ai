import type { DaemonHandler } from "../../core/spec";
import { listTabs } from "../../core/tabs";

const tabList: DaemonHandler = async (ctx) => ({ result: await listTabs(ctx), code: "await page.context().pages();" });

export default tabList;
