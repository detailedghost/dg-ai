import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";

const dgHome = process.env.DG_HOME;
if (dgHome === undefined || dgHome.length === 0) {
	throw new Error("DG_HOME is required");
}

const paths = resolveDgPaths({ env: { DG_HOME: dgHome, DG_KEY_SOURCE: "file" } });
const store = await ChatStore.open(paths, {
	env: { DG_HOME: dgHome, DG_KEY_SOURCE: "file" },
});
const pruned = store.pruneArchive(Date.now(), { maxRows: 0, ttlMs: 60_000 });
store.close();
process.stdout.write(JSON.stringify(pruned));
