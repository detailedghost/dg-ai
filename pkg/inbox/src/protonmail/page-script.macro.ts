import { fileURLToPath } from "node:url";

export function buildProtonPageScript(): string {
	const entry = fileURLToPath(new URL("./page-entry.ts", import.meta.url));
	const built = Bun.spawnSync(
		[process.execPath, "build", entry, "--target=browser", "--format=iife", "--minify"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (!built.success)
		throw new Error(`Proton page script build failed: ${built.stderr.toString()}`);
	return `async (call) => {${built.stdout.toString()};const run = globalThis.__dgProtonRun;delete globalThis.__dgProtonRun;return run(call);}`;
}
