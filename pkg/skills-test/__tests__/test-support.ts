import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export function readRepoFile(...parts: string[]): string {
	return readFileSync(join(REPO_ROOT, ...parts), "utf8");
}

export type HarnessResult = { code: number; stdout: string; stderr: string };

export async function runInHarness(
	source: string,
	env: Record<string, string>,
): Promise<HarnessResult> {
	const dir = mkdtempSync(join(tmpdir(), "dg-harness-"));
	const file = join(dir, "harness.ts");
	writeFileSync(file, source);
	try {
		const proc = Bun.spawn(["bun", "run", file], {
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const code = await proc.exited;
		return { code, stdout, stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
