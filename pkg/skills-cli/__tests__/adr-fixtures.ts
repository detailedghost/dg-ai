import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { git, makeTempDir } from "./git-repo-fixtures";
import { CLI_ENTRY, type CliRun, mergeEnv, runCli } from "./module-call";

export const NOT_INITIALIZED = "adr: not initialized. Run dg adr init first.";
export const TOC_MARKER = "<!-- adr:index -->";

export interface AdrRepo {
	root: string;
	adr(args: string[], stdin?: string): Promise<CliRun>;
	read(path: string): string;
	write(path: string, content: string): void;
	exists(path: string): boolean;
	list(dir: string): string[];
	snapshot(): Record<string, string>;
	create(title: string, topic: string, extra?: string[]): Promise<CliRun>;
	renumber(from: string, to: string): void;
}

const created: string[] = [];

export function disposeAdrRepos(): void {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function walk(root: string, dir = root): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (name === ".git") return [];
		return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
	});
}

/** A temp git repo; `init` runs `adr init` through the CLI, with an optional level. */
export async function makeAdrRepo(options: { init?: boolean; level?: string } = {}): Promise<AdrRepo> {
	const base = makeTempDir("dg-adr-");
	created.push(base);
	const root = join(base, "repo");
	mkdirSync(root, { recursive: true });
	mkdirSync(join(base, "home"), { recursive: true });
	git(["init", "-q", "-b", "main"], root);
	const env = mergeEnv({
		HOME: join(base, "home"),
		NO_COLOR: "1",
		LC_ALL: "C",
		TZ: "UTC",
		GIT_DIR: undefined,
		GIT_WORK_TREE: undefined,
	});
	const repo: AdrRepo = {
		root,
		adr: (args, stdin) => runCli([process.execPath, CLI_ENTRY, "adr"], args, { cwd: root, env, stdin }),
		read: (path) => readFileSync(join(root, path), "utf8"),
		write: (path, content) => {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		},
		exists: (path) => existsSync(join(root, path)),
		list: (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).sort() : []),
		snapshot: () => Object.fromEntries(walk(root).map((path) => [path, readFileSync(join(root, path), "utf8")])),
		create: (title, topic, extra = []) => repo.adr(["new", title, "--topic", topic, ...extra]),
		renumber: (from, to) => {
			for (const dir of ["docs/adr", ".agents/decisions"]) {
				renameSync(join(root, dir, `${from}.md`), join(root, dir, `${to}.md`));
			}
		},
	};
	if (options.init !== false) {
		const args = options.level === undefined ? ["init"] : ["init", "--level", options.level];
		const run = await repo.adr(args);
		if (run.exitCode !== 0) throw new Error(`adr init failed: ${run.stderr}`);
	}
	return repo;
}

/** The leading frontmatter block of a markdown file, delimiters included. */
export function frontmatterBlock(text: string): string {
	const match = text.match(/^---\n[\s\S]*?\n---\n/);
	return match?.[0] ?? "";
}
