import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

export function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}

export function removeTempDirs(): void {
	for (const dir of created.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export const LOCAL_DEFAULT = /off \(local is the default\)/;
export const GATE_COMMAND = /dg-skills\s+require-extension\s+\S+\s*\|\|/;

export function frontmatter(text: string): string {
	return /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
}

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
			cwd: dir,
			env: { ...process.env, DG_HOME: undefined, DG_SKILLS: undefined, ...env },
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
