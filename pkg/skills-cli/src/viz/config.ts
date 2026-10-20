import { existsSync } from "node:fs";
import path from "node:path";
import { scratchRoot } from "@dg/common/node";
import { resolveSkillAsset } from "../utils/skill-assets";

export const STALE_LOCK_MS = 30_000;

export interface VizConfig {
	port: number;
	vizDir: string;
	log: string;
	lock: string;
	pidFile: string;
}

/** Read VIZ_PORT and VIZ_DIR at call time so importing the module stays inert. */
export function vizConfig(): VizConfig {
	const port = parseInt(process.env.VIZ_PORT ?? "4321", 10);
	const vizDir = process.env.VIZ_DIR ?? path.join(scratchRoot(), "viz");
	return {
		port,
		vizDir,
		log: `${vizDir}/astro-${port}.log`,
		lock: `${vizDir}/.server-${port}.lock`,
		pidFile: `${vizDir}/.server-${port}.pid`,
	};
}

export const sessionDir = (slug: string): string =>
	`${vizConfig().vizDir}/${slug}`;

export const sessionUrl = (slug: string): string =>
	`http://localhost:${vizConfig().port}/viz/${slug}`;

/** Locate the installed viewer from VIZ_SKILL_DIR or the real installed viz skill. */
export function astroDir(): string {
	const skillDir = process.env.VIZ_SKILL_DIR;
	if (skillDir) {
		const dir = path.join(skillDir, "astro-viewer");
		if (!existsSync(path.join(dir, "package.json")))
			throw new Error(
				`no viz viewer at ${dir} — VIZ_SKILL_DIR must point at the installed viz skill directory`,
			);
		return dir;
	}
	return path.dirname(resolveSkillAsset("viz", "astro-viewer/package.json"));
}
