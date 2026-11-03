import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildPages, OPTIONS_CSS } from "../../pages/build";

const pages = join(import.meta.dir, "../../pages");
const common = join(import.meta.dir, "../../common");
const BUILT = ["chat.html", "chat.js", "board.html", "board.js"].map((name) =>
	join(pages, "dist", name),
);

function newestSource(): number {
	let newest = Math.max(
		statSync(join(pages, "build.ts")).mtimeMs,
		statSync(OPTIONS_CSS).mtimeMs,
	);
	for (const root of [pages, common])
		for (const file of new Bun.Glob("src/**/*.{ts,css}").scanSync({ cwd: root }))
			newest = Math.max(newest, statSync(join(root, file)).mtimeMs);
	return newest;
}

function oldestBuilt(): number {
	return Math.min(...BUILT.map((path) => statSync(path).mtimeMs));
}

if (!BUILT.every(existsSync) || oldestBuilt() < newestSource())
	await buildPages();
