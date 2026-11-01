import { join } from "node:path";

export const PLAYER_BUDGET_BYTES = 120 * 1024;
export const PLAYER_PATH = join(import.meta.dir, "dist/player.js");

/** Builds the player IIFE; `entry` and `outdir` default to the real player. */
export async function buildPlayer(
	entry = join(import.meta.dir, "src/hosts/player-entry.ts"),
	outdir = join(import.meta.dir, "dist"),
): Promise<string> {
	const result = await Bun.build({
		entrypoints: [entry],
		format: "iife",
		minify: true,
		target: "browser",
		outdir,
		naming: "player.js",
	});
	if (!result.success)
		throw new AggregateError(result.logs, "Tour player build failed.");
	const out = join(outdir, "player.js");
	const size = Bun.file(out).size;
	if (size >= PLAYER_BUDGET_BYTES)
		throw new Error(
			`Tour player is ${size} bytes; the budget is ${PLAYER_BUDGET_BYTES}.`,
		);
	return out;
}

if (import.meta.main) await buildPlayer();
