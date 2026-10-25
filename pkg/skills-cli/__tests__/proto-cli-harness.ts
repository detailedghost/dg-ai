import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnv } from "./module-call";
import { type CliResult, inboxDaemonFixture } from "./inbox-cli-harness";

export const skillsEntry = join(import.meta.dir, "../src/index.ts");
export { type CliResult, inboxDaemonFixture as protoDaemonFixture };

export function protoCliHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "dg-proto-cli-"));
	const dgHome = join(cwd, "dg-home");
	const scratch = join(cwd, "scratch");
	return {
		cwd,
		dgHome,
		scratch,
		async run(
			args: string[],
			overrides: Record<string, string | undefined> = {},
			options: { timeoutMs?: number } = {},
		): Promise<CliResult> {
			const proc = Bun.spawn(
				[process.execPath, skillsEntry, "proto", "--ext", ...args],
				{
					cwd,
					env: mergeEnv({
						DG_HOME: dgHome,
						AI_SCRATCH_DIR: scratch,
						...overrides,
					}),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			let timedOut = false;
			const timer = options.timeoutMs
				? setTimeout(() => {
						timedOut = true;
						proc.kill();
					}, options.timeoutMs)
				: undefined;
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (timer !== undefined) clearTimeout(timer);
			return {
				code,
				stdout,
				stderr,
				...(options.timeoutMs ? { timedOut } : {}),
			};
		},
		cleanup() {
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}
