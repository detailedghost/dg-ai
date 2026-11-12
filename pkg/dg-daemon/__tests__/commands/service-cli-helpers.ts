import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { ENTRY, subprocessEnv } from "../utils/daemon-harness";

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

export const configPathOf = (dgHome: string): string =>
	resolveDgPaths({ env: { DG_HOME: dgHome } }).daemonConfigPath;

export function writeConfigFile(dgHome: string, contents: unknown): string {
	const file = configPathOf(dgHome);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
	return file;
}

export const readConfigFile = (dgHome: string): Record<string, any> =>
	JSON.parse(readFileSync(configPathOf(dgHome), "utf8"));

export const lines = (text: string): string[] =>
	text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
