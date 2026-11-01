import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { runHook } from "../../src/hooks/run";
import { scratchFixtures } from "../git-repo-fixtures";

export interface CommandReply {
	status: number;
	stdout?: string;
	stderr?: string;
}

export interface CommandCall {
	argv: string[];
	cwd?: string;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	env?: Record<string, string | undefined>;
	reply?: CommandReply;
	replyFor?: (argv: string[]) => CommandReply | undefined;
	which?: (bin: string) => string | undefined;
	spawn?: (argv: string[]) => void;
}

export const SESSION = "TEST";

export function editInput(
	newString: string,
	extra: Record<string, unknown> = {},
) {
	return {
		session_id: SESSION,
		tool_name: "Edit",
		tool_input: {
			file_path: "/nonexistent/dir/file.ts",
			old_string: "",
			new_string: newString,
		},
		...extra,
	};
}

export function writeInput(filePath: string, content: string) {
	return {
		session_id: SESSION,
		tool_name: "Write",
		tool_input: { file_path: filePath, content },
	};
}

export function bashInput(
	command: string,
	field: "command" | "cmd" = "command",
) {
	return {
		session_id: SESSION,
		tool_name: "Bash",
		tool_input: { [field]: command },
	};
}

export function hookWorld() {
	const fixtures = scratchFixtures();
	const scratch = fixtures.tmp("hook-scratch-");
	const state = fixtures.tmp("hook-state-");
	const dgHome = fixtures.tmp("hook-dg-home-");
	const work = fixtures.tmp("hook-work-");
	const calls: CommandCall[] = [];
	const spawned: string[][] = [];

	function env(extra: Record<string, string | undefined> = {}) {
		return {
			AI_SCRATCH_DIR: scratch,
			AI_STATE_DIR: state,
			DG_HOME: dgHome,
			HOME: work,
			PATH: "/usr/bin:/bin",
			...extra,
		};
	}

	function setConfig(config: Record<string, unknown>) {
		writeFileSync(join(dgHome, "config.json"), JSON.stringify(config));
	}

	function setSpellingLocale(locale: string) {
		setConfig({ hooks: { spelling: { locale } } });
	}

	function seed(rel: string, text: string) {
		const full = join(work, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
		return full;
	}

	function disableMarker(name: string, session = SESSION) {
		const dir = join(scratch, "hooks");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.${session}`), "");
	}

	async function run(
		id: string,
		input: unknown,
		opts: RunOptions = {},
	): Promise<RunResult> {
		let stdout = "";
		let stderr = "";
		const code = await runHook(
			id,
			Readable.from([JSON.stringify(input)]),
			env(opts.env),
			{
				run: async (argv: string[], o?: { cwd?: string }) => {
					calls.push({ argv, cwd: o?.cwd });
					const reply = opts.replyFor?.(argv) ?? opts.reply ?? { status: 0 };
					return {
						status: reply.status,
						stdout: reply.stdout ?? "",
						stderr: reply.stderr ?? "",
					};
				},
				which: opts.which ?? (() => undefined),
				spawnDetached: (argv: string[]) => {
					if (opts.spawn) return opts.spawn(argv);
					spawned.push(argv);
				},
				stdout: (text: string) => {
					stdout += text;
				},
				stderr: (text: string) => {
					stderr += text;
				},
			},
		);
		return { code, stdout, stderr };
	}

	return {
		...fixtures,
		scratch,
		state,
		dgHome,
		work,
		calls,
		spawned,
		env,
		setConfig,
		setSpellingLocale,
		seed,
		disableMarker,
		run,
	};
}
