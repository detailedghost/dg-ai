import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { slugify } from "@dg/common";
import type { SystemSeams } from "@dg/common/node";

/** Stable collision-resistant slug derived from a URL's host/path and full URL. */
export function protoSlug(url: string): string {
	const parsed = new URL(url);
	const stem =
		slugify(`${parsed.hostname}${parsed.pathname}`, "prototype")
			.replace(/^[^a-z0-9]+/, "")
			.slice(0, 119) || "prototype";
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
	return `${stem}-${hash}`;
}

/**
 * Durable prototype answer path, resolved from the invoking project's cwd.
 *
 * Unlike agent scratch, callers must run answer-writing commands from the
 * target project root.
 */
export function answerPagePath(slug: string, file: string): string {
	return resolve(process.cwd(), ".agents", "prototype", slug, file);
}

/** Stable agent output path; never points into Downloads or repository state. */
export function protoScratchPath(
	slug: string,
	file: string,
	seams: Pick<SystemSeams, "env" | "homeDir"> = {},
): string {
	const env = seams.env ?? process.env;
	const homeDir = seams.homeDir ?? homedir();
	const root = env.AI_SCRATCH_DIR
		? join(env.AI_SCRATCH_DIR, "proto")
		: join(homeDir, ".dg", "proto");
	return join(root, slug, file);
}
