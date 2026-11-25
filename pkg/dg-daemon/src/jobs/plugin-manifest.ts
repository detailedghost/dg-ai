import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { parseManifest, type PluginManifest } from "../../../common/src/plugins/manifest";
import { type DeclaredJob, type DeclarationContext, parseJobDeclaration } from "./declaration";

export const MANIFEST_FILE = "plugin.toml";
const MAX_MANIFEST_BYTES = 64 * 1024;

export type FolderManifest = {
	manifest: PluginManifest;
	dg: { jobs: Record<string, Record<string, unknown>> };
};

function manifestDg(manifest: PluginManifest): FolderManifest["dg"] {
	if (manifest.kind !== "job") {
		throw new DgCliError(`dg job: ${MANIFEST_FILE} is a ${manifest.kind} plugin, not a job. Next: set kind = "job" in ${MANIFEST_FILE}.`);
	}
	if (!("command" in manifest.entry)) {
		throw new DgCliError(`dg job: ${MANIFEST_FILE} has a built-in entry, which has no argv. Next: set entry.command and entry.args in ${MANIFEST_FILE}.`);
	}
	const { command, args } = manifest.entry;
	const { credentials } = manifest.permissions;
	return {
		jobs: {
			[manifest.name]: {
				argv: [command, ...args],
				continuous: true,
				...(credentials.length === 0 ? {} : { credentials }),
			},
		},
	};
}

/** The job a plugin.toml of kind job declares, checked like a package.json dg block. */
export function jobFromManifest(manifest: PluginManifest, context: DeclarationContext): DeclaredJob {
	const declaration = parseJobDeclaration({ dg: manifestDg(manifest) }, context);
	if (!declaration.ok) throw new DgCliError(`dg job: ${MANIFEST_FILE}: ${declaration.error}. Next: fix ${MANIFEST_FILE}.`);
	return declaration.jobs[0] as DeclaredJob;
}

/** Reads plugin.toml from a folder; undefined when the folder has none. */
export function readFolderManifest(dir: string): FolderManifest | undefined {
	const file = join(dir, MANIFEST_FILE);
	if (!existsSync(file)) return undefined;
	if (statSync(file).size > MAX_MANIFEST_BYTES) {
		throw new DgCliError(`dg job: ${file} is larger than 64 KiB. Next: shrink ${MANIFEST_FILE}.`);
	}
	const manifest = parseManifest(readFileSync(file, "utf8"), file);
	return { manifest, dg: manifestDg(manifest) };
}
