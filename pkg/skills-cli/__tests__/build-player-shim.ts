import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildPlayer, PLAYER_PATH } from "../../tour-ui/build";

const tourUi = join(import.meta.dir, "../../tour-ui");

function newestSource(): number {
	let newest = statSync(join(tourUi, "build.ts")).mtimeMs;
	for (const file of new Bun.Glob("src/**/*.ts").scanSync({ cwd: tourUi }))
		newest = Math.max(newest, statSync(join(tourUi, file)).mtimeMs);
	return newest;
}

if (!existsSync(PLAYER_PATH) || statSync(PLAYER_PATH).mtimeMs < newestSource())
	await buildPlayer();
