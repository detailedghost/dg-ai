import { afterAll } from "bun:test";
import { killTrackedChildren, settleChildren } from "./utils/child-registry";

afterAll(async () => {
	const leaked = await settleChildren();
	await killTrackedChildren();
	if (leaked > 0) {
		throw new Error(`${leaked} child process(es) a spec started were still alive at the end of the file`);
	}
});
