import { getBooleanFlag, getStringFlag } from "../../cli/args";
import { workspaceDirForContext, type CliContext } from "../../cli/context";
import { printJson } from "../../cli/output";
import { createProtonMailClient } from "../../protonmail/client";
import { fullSieveOrThrow } from "./parse";
import {
	declaredFiltersPath,
	readDeclaredFiltersIfExists,
	seedDeclaredFromLive,
	writeDeclaredFilters,
} from "./store";

export async function importDeclaredFilters(context: CliContext): Promise<void> {
	if (context.config.provider !== "protonmail") {
		throw new Error(
			"filters import captures a Proton Mail mailbox into the declared filters file.",
		);
	}
	const dir = workspaceDirForContext(context);
	const path =
		getStringFlag(context.args.flags, "declared-path") ||
		declaredFiltersPath(dir);
	const replace = getBooleanFlag(context.args.flags, "replace");
	const existing = await readDeclaredFiltersIfExists(path);
	if (existing && !replace) {
		throw new Error(
			`Declared filters file already exists at ${path}. Pass --replace to capture Proton again.`,
		);
	}
	const client = createProtonMailClient(context.config);
	try {
		const folders = await client.listFolders();
		const filters = await client.listFilters();
		const file = seedDeclaredFromLive({
			filters: filters.map((filter) => ({
				id: filter.id,
				name: filter.name,
				enabled: filter.enabled,
				sieve: fullSieveOrThrow(filter),
			})),
			folders: folders.map((folder) => ({
				id: folder.id,
				name: folder.name,
				path: folder.path,
				type: folder.type,
			})),
			...(existing ? { policy: existing.policy } : {}),
		});
		await writeDeclaredFilters(path, file);
		printJson({
			kind: "proton-filter-import",
			path,
			filters: file.filters.length,
			folders: file.folders.length,
			replaced: Boolean(existing),
		});
	} finally {
		await client.close?.();
	}
}
