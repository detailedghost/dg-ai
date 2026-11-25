import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { resolveDgPaths } from "../../../../../pkg/common/src/node/dg-paths";
import { main } from "../../../../../pkg/skills-cli/src/hooks/cli";
import { runCommand } from "../../../../../pkg/skills-cli/src/hooks/spawn";
import { createEmitter } from "../../../fixture-support";

const dir = import.meta.dir;
const check = process.argv.includes("--check");

type FileValue = string | { base64: string };

interface Case {
	hook: string;
	args?: string[];
	event?: unknown;
	stdin?: string;
	env?: Record<string, string>;
	config?: string;
	files?: Record<string, FileValue>;
	bin?: Record<string, string>;
	cwd?: string;
}

function substitute<T>(value: T, root: string): T {
	return JSON.parse(JSON.stringify(value).replaceAll("$CWD", root)) as T;
}

function plant(root: string, files: Record<string, FileValue>): void {
	for (const [name, value] of Object.entries(files)) {
		const target = join(root, name);
		if (name.endsWith("/")) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, typeof value === "string" ? value : Buffer.from(value.base64, "base64"));
	}
}

function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isDirectory()) {
				if (![".git", "home", "bin"].includes(entry.name)) walk(join(current, entry.name));
			} else {
				const bytes = readFileSync(join(current, entry.name));
				let text: string;
				try {
					text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
				} catch {
					text = `base64:${bytes.toString("base64")}`;
				}
				out[relative(root, join(current, entry.name)).split("\\").join("/")] = text;
			}
		}
	};
	walk(root);
	return out;
}

async function run(entry: Case): Promise<Record<string, unknown>> {
	const root = mkdtempSync(join(tmpdir(), "dg-hooks-pr-"));
	const saved = { ...process.env };
	try {
		for (const sub of ["work", "bin", "home", "repo"]) mkdirSync(join(root, sub));
		const env: Record<string, string> = substitute(
			{
				HOME: "$CWD/home",
				TMPDIR: "$CWD/work",
				DG_HOME: "$CWD/home",
				DG_PATH_FENCE: "$CWD",
				AI_SCRATCH_DIR: "$CWD/scratch",
				PATH: "$CWD/bin",
				...entry.env,
			},
			root,
		);
		plant(root, substitute(entry.files ?? {}, root));
		for (const [name, script] of Object.entries(entry.bin ?? {})) {
			writeFileSync(join(root, "bin", name), script);
			chmodSync(join(root, "bin", name), 0o755);
		}
		if (entry.config !== undefined) {
			const file = resolveDgPaths({ env }).configTomlPath;
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, entry.config);
		}
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, env);
		const stdout: string[] = [];
		const stderr: string[] = [];
		const stdinText =
			entry.stdin !== undefined
				? entry.stdin
				: entry.event === undefined
					? ""
					: JSON.stringify(substitute(entry.event, root));
		const exit = await main(["run", entry.hook, ...substitute(entry.args ?? [], root)], {
			stdin: (async function* () {
				yield stdinText;
			})(),
			env,
			cwd: entry.cwd === undefined ? undefined : join(root, entry.cwd),
			seams: {
				run: (argv, opts) => {
					const bin = Bun.which(argv[0] as string, { PATH: env["PATH"] as string });
					return runCommand(bin ? [bin, ...argv.slice(1)] : argv, opts);
				},
				which: (bin) => Bun.which(bin, { PATH: env["PATH"] as string }) ?? undefined,
				spawnDetached: () => {},
				stdout: (text) => void stdout.push(text),
				stderr: (text) => void stderr.push(text),
			},
		});
		const result = { exit, stdout: stdout.join(""), stderr: stderr.join(""), after: snapshot(root) };
		const leaked = JSON.stringify(result).includes(root);
		if (leaked) throw new Error(`fixture output contains the temp path: ${entry.hook} ${JSON.stringify(result).slice(0, 600)}`);
		return result;
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(root, { recursive: true, force: true });
	}
}

const { emit, finish } = createEmitter(dir, check, (name) => name.endsWith(".expected.json"));

for (const file of readdirSync(dir).filter((name) => name.endsWith(".case.json")).sort()) {
	const base = file.slice(0, -".case.json".length);
	const entry = JSON.parse(readFileSync(join(dir, file), "utf8")) as Case;
	emit(`${base}.expected.json`, `${JSON.stringify(await run(entry), null, "\t")}\n`);
}

finish("run bun generate.ts");
