import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { type HooksIo, main } from "../../src/hooks/cli";
import { defaultSeams } from "../../src/hooks/run";
import type { HookSeams } from "../../src/hooks/types";
import { scratchFixtures } from "../git-repo-fixtures";

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface HookObject {
	type?: string;
	command?: string;
	[key: string]: unknown;
}

export interface HookGroup {
	matcher?: string;
	hooks: HookObject[];
}

export type SettingsFile = {
	hooks?: Record<string, HookGroup[]>;
	[key: string]: unknown;
};

export const USER_HOOK: HookObject = {
	type: "command",
	command: "/usr/local/bin/my-own-hook --flag",
};

export function settingsWorld() {
	const fixtures = scratchFixtures();
	const home = fixtures.tmp("hooks-settings-home-");
	const dgHome = fixtures.tmp("hooks-settings-dg-");
	const launcher = join(dgHome, "bin", "dg-skills");

	const paths = {
		claude: join(home, ".claude", "settings.json"),
		codex: join(home, ".codex", "hooks.json"),
		opencodeDir: join(home, ".config", "opencode"),
		opencodeJson: join(home, ".config", "opencode", "opencode.json"),
		opencodePlugin: join(home, ".config", "opencode", "plugins", "dg-hooks.js"),
		config: join(dgHome, "config.json"),
	};

	function seed(file: string, content: string | object) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			typeof content === "string" ? content : JSON.stringify(content, null, 2),
		);
		return file;
	}

	function readJson<T = SettingsFile>(file: string): T {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	}

	function text(file: string): string {
		return readFileSync(file, "utf8");
	}

	function has(file: string): boolean {
		return existsSync(file);
	}

	async function cli(
		argv: string[],
		overrides: {
			launcher?: string;
			env?: Record<string, string | undefined>;
			seams?: Partial<HookSeams>;
		} = {},
	): Promise<CliResult> {
		const out = { stdout: "", stderr: "" };
		const io: HooksIo = {
			stdin: Readable.from([]),
			env: {
				DG_HOME: dgHome,
				HOME: home,
				PATH: "/usr/bin:/bin",
				...overrides.env,
			},
			home,
			launcher: overrides.launcher ?? launcher,
			seams: {
				...defaultSeams(),
				run: async () => ({ status: 0, stdout: "", stderr: "" }),
				which: () => undefined,
				spawnDetached: () => {},
				stdout: (t: string) => {
					out.stdout += t;
				},
				stderr: (t: string) => {
					out.stderr += t;
				},
				...overrides.seams,
			},
		};
		const code = await main(argv, io);
		return { code, ...out };
	}

	return {
		...fixtures,
		home,
		dgHome,
		launcher,
		paths,
		seed,
		readJson,
		text,
		has,
		cli,
	};
}

const OWNED_COMMAND =
	/(?:^|[\\/])dg-skills(?:\.cmd|\.exe)?["']? hooks run [a-z-]+$/;

export function ownedObjects(file: SettingsFile): HookObject[] {
	return Object.values(file.hooks ?? {})
		.filter((groups): groups is HookGroup[] => Array.isArray(groups))
		.flatMap((groups) =>
			groups.flatMap((g) =>
				g.hooks.filter((h) => OWNED_COMMAND.test(h.command ?? "")),
			),
		);
}
