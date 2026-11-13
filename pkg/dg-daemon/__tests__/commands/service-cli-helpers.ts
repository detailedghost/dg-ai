import { readFileSync } from "node:fs";
import { ENTRY, subprocessEnv } from "../utils/daemon-harness";
import { configPathOf } from "../utils/service-daemon";

export type RunResult = { code: number; stdout: string; stderr: string };

export async function runCli(
	dgHome: string,
	args: string[],
	options: { port?: number; cwd?: string } = {},
): Promise<RunResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
		env: subprocessEnv(dgHome, options.port ?? 0),
		cwd: options.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

export const readConfigFile = (dgHome: string): unknown =>
	JSON.parse(readFileSync(configPathOf(dgHome), "utf8"));

export const lines = (text: string): string[] =>
	text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
