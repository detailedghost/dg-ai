import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildBundle } from "../../skills-cli/__tests__/bundle-build";

export { buildBundle };

export interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	ms: number;
}

export function run(bun: string, entry: string, args: string[], env?: Record<string, string>): RunResult {
	const start = performance.now();
	const proc = Bun.spawnSync([bun, entry, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, ...env },
	});
	return {
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		exitCode: proc.exitCode ?? -1,
		ms: performance.now() - start,
	};
}

export function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...walkFiles(path));
		else out.push(path);
	}
	return out;
}

export function dirBytes(dir: string): number {
	return walkFiles(dir).reduce((sum, file) => sum + statSync(file).size, 0);
}

export function chunkFiles(lib: string): string[] {
	return walkFiles(join(lib, "chunks")).filter((file) => file.endsWith(".js"));
}

export function median(values: number[]): number {
	const sorted = [...values].sort((x, y) => x - y);
	return sorted[Math.floor(sorted.length / 2)] as number;
}

export function budgetScale(): number {
	const scale = Number(process.env.DG_BUDGET_SCALE ?? "1");
	return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export interface TracedLib {
	entry: string;
	dir: string;
	sentinels: Map<string, string>;
}

let traced: TracedLib | undefined;

export function cleanupTraces(): void {
	if (traced) rmSync(traced.dir, { recursive: true, force: true });
	traced = undefined;
}

export function chunkBaseName(relativePath: string): string {
	return relativePath.replace(/-[0-9a-z]{8}\.js$/, "");
}

/** Copy dist/lib once and append a sentinel write to every chunk so a load is observable. Sentinels reset on each call; filter the returned map by chunkBaseName. */
export function traceChunks(match: RegExp): TracedLib {
	if (!traced) {
		const { lib } = buildBundle();
		const dir = mkdtempSync(join(tmpdir(), "dg-launcher-trace-"));
		const copy = join(dir, "lib");
		cpSync(lib, copy, { recursive: true });
		const all = new Map<string, string>();
		for (const file of chunkFiles(copy)) {
			const sentinel = join(dir, `loaded-${all.size}`);
			appendFileSync(
				file,
				`\n;globalThis.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(sentinel)},"");\n`,
			);
			all.set(relative(copy, file), sentinel);
		}
		traced = { entry: join(copy, "dg.js"), dir, sentinels: all };
	}
	for (const sentinel of traced.sentinels.values()) rmSync(sentinel, { force: true });
	const sentinels = new Map([...traced.sentinels].filter(([name]) => match.test(chunkBaseName(name))));
	return { entry: traced.entry, dir: traced.dir, sentinels };
}
