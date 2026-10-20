import { existsSync, readFileSync } from "node:fs";
import { sessionUrl } from "../config";
import { die, note } from "../io";
import { ensureServer, openUrlOnce } from "../server";
import { mutatePayload, validateSlug } from "../session";

export async function cmdAnnotate(rest: string[]): Promise<void> {
	const [rawSlug, patchFile] = rest;
	if (!rawSlug || !patchFile)
		die("usage: dg-skills viz annotate <slug> <patch.json>");
	const slug = validateSlug(rawSlug);
	if (!existsSync(patchFile)) die(`patch file not found: ${patchFile}`);

	const patchesRaw = JSON.parse(readFileSync(patchFile, "utf-8"));
	if (!Array.isArray(patchesRaw))
		throw new Error(`patch file must be a JSON array: ${patchFile}`);
	const patches = patchesRaw as { index: number; [key: string]: unknown }[];

	await mutatePayload(slug, (payload) => {
		if (!Array.isArray(payload.decisions)) payload.decisions = [];
		const decisions = payload.decisions as Record<string, unknown>[];
		for (const patch of patches) {
			const d = decisions[patch.index];
			if (!d) continue;
			for (const [key, val] of Object.entries(patch)) {
				if (key !== "index") d[key] = val;
			}
		}
	});

	await ensureServer();
	openUrlOnce(slug, sessionUrl(slug));
	note(`annotated → ${sessionUrl(slug)}`);
}
