import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DgPaths } from "@dg/common/node";
import type { ChatStore } from "../store";
import { getConfiguredAssetDirectory } from "./config";
import { assertFlatSegment, lstatIfExists } from "./safe-path";

/** Marks one session asset deleted and removes its staged file. */
export function deleteStagedAsset(
	deps: { paths: DgPaths; store: ChatStore },
	sessionId: string,
	id: string,
): void {
	assertFlatSegment(sessionId);
	assertFlatSegment(id);
	deps.store.deleteAsset(sessionId, id);
	const file = join(getConfiguredAssetDirectory(deps.paths), sessionId, id);
	if (lstatIfExists(file)?.isFile() === true) rmSync(file, { force: true });
}
