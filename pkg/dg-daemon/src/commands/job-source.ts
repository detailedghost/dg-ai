import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { resolve } from "node:path";
import {
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	isRecord,
	isReservedCredentialPrefix,
} from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	insideRoot,
	isJobName,
	jobSourceDir,
	jobStateDir,
	readLine,
	removeInside,
	resolveDgPaths,
	writeFilePreserving,
} from "@dg/common/node";
import { JOBS_CONFIG_KEY } from "../jobs/config";
import {
	type DeclaredJob,
	declarationHash,
	describeCredentials,
	parseJobDeclaration,
} from "../jobs/declaration";
import { sanitize } from "../jobs/sanitize";
import {
	findRecordByJob,
	type GitSourceRecord,
	readSources,
	type SourceRegistry,
	writeSource,
} from "../jobs/sources";
import { readConfigStrict, writeJobEntry } from "../server/config-store";
import {
	ensureMigrated,
	guardConfig,
	isInTable,
	type JobVerbDeps,
	defaultJobVerbDeps,
	requireMigrated,
	resolveExecutable,
	withConfigLock,
} from "./job-support";

export type GitResult = { code: number; stdout: string; stderr: string };

export type GitOptions = {
	cwd?: string;
	env: Record<string, string | undefined>;
	stdin: "inherit" | "ignore";
};

export type JobSourceDeps = JobVerbDeps & {
	runGit(args: string[], options: GitOptions): Promise<GitResult>;
	runBuild(argv: string[], cwd: string): Promise<number>;
};

export type SourceAddOptions = { name?: string; label?: string; yes?: boolean };

const CONSENT_QUESTION = "Add these jobs? [y/N]";
const SAFE_GIT = ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never"];
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP = /^[^/\\]+@[^/\\:]+:/;
const DRIVE = /^[a-zA-Z]:[\\/]/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MODE_KEYS = ["continuous", "schedule", "every"];

function fail(message: string): never {
	throw new DgCliError(message, EXIT_GENERAL_FAILURE);
}

function stop(message: string): never {
	return fail(sanitize(`job add: ${message}`));
}

type Child = { kill(): void; exited: Promise<number> };

const activeChildren = new Set<Child>();
const CHILD_EXIT_WAIT_MS = 2000;

class RollbackFailure extends DgCliError {}

const strictConfirm = async (question: string): Promise<boolean> => {
	const line = await readLine(`${question} `);
	return line !== null && ["y", "yes"].includes(line.trim().toLowerCase());
};

async function defaultRunGit(args: string[], options: GitOptions): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: options.cwd,
		env: options.env,
		stdin: options.stdin,
		stdout: "pipe",
		stderr: "pipe",
	});
	activeChildren.add(proc);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		activeChildren.delete(proc);
	}
}

async function defaultRunBuild(argv: string[], cwd: string): Promise<number> {
	const proc = Bun.spawn(argv, {
		cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	activeChildren.add(proc);
	try {
		return await proc.exited;
	} finally {
		activeChildren.delete(proc);
	}
}

export const defaultJobSourceDeps = (): JobSourceDeps => ({
	...defaultJobVerbDeps(),
	confirm: strictConfirm,
	isTerminal: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
	runGit: defaultRunGit,
	runBuild: defaultRunBuild,
});

export function classifySource(argument: string): "git" | "path" {
	if (argument.startsWith("-")) stop('a URL or a ref cannot start with "-"');
	const helper = /^([A-Za-z0-9+.-]+)::/.exec(argument);
	if (helper) stop(`the URL scheme "${helper[1].toLowerCase()}::" is not allowed`);
	if (SCHEME.test(argument) || SCP.test(argument)) return "git";
	if (/^(\.\.?\/|\/|~)/.test(argument) || DRIVE.test(argument)) return "path";
	return stop(
		`"${argument}" is not a path or a URL — for a local file write ./${argument}`,
	);
}

export function splitGitArgument(value: string): { url: string; ref: string | null } {
	const body = value.replace(SCHEME, "");
	const at = body.lastIndexOf("@");
	if (at > 0 && /[/:]/.test(body.slice(0, at))) {
		return {
			url: value.slice(0, value.length - body.length + at),
			ref: body.slice(at + 1),
		};
	}
	return { url: value, ref: null };
}

export function displayUrl(url: string): string {
	const scheme = SCHEME.exec(url);
	if (scheme) {
		const rest = url.slice(scheme[0].length);
		const end = rest.indexOf("/") < 0 ? rest.length : rest.indexOf("/");
		const authority = rest.slice(0, end);
		return `${scheme[0]}${authority.slice(authority.lastIndexOf("@") + 1)}${rest.slice(end)}`;
	}
	return SCP.test(url) ? url.slice(url.indexOf("@") + 1) : url;
}

function decodedUser(user: string): string {
	try {
		return decodeURIComponent(user);
	} catch {
		return user.replace(/%3a/gi, ":");
	}
}

function refuseCredentialsInUrl(value: string): void {
	let user: string | undefined;
	const scheme = SCHEME.exec(value);
	if (scheme) {
		const rest = value.slice(scheme[0].length);
		const authority = rest.slice(0, rest.indexOf("/") < 0 ? rest.length : rest.indexOf("/"));
		const at = authority.lastIndexOf("@");
		user = at < 0 ? undefined : authority.slice(0, at);
	} else if (SCP.test(value)) {
		user = value.slice(0, value.indexOf("@"));
	}
	if (user !== undefined && decodedUser(user).includes(":")) {
		stop("put no password in the URL — use a git credential helper or an ssh key");
	}
}

function sourceNameOf(url: string, options: SourceAddOptions): string {
	const given = options.name ?? options.label;
	const trimmed = url.replace(/\/+$/, "");
	const segment = trimmed
		.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":")) + 1)
		.replace(/\.git$/i, "");
	const candidate = given ?? segment.toLowerCase();
	if (!isJobName(candidate)) {
		stop(`cannot use "${given ?? segment}" as a source name — give one with --name`);
	}
	return candidate;
}

/** The one clash check for a credential prefix: a reserved name, a job, a grant or a source. */
export function assertPrefixFree(
	name: string,
	config: Record<string, unknown>,
	registry: SourceRegistry,
	errorPrefix: string,
): void {
	const taken = (by: string): never =>
		fail(`${errorPrefix} "${name}" is already used as a credential prefix by ${by}`);
	const lower = name.toLowerCase();
	if (isReservedCredentialPrefix(lower)) {
		fail(`${errorPrefix} "${name}" is a reserved name — give another one with --name`);
	}
	const table = config[JOBS_CONFIG_KEY];
	for (const [job, entry] of isRecord(table) ? Object.entries(table) : []) {
		const grant = isRecord(entry) && typeof entry.grant === "string" ? entry.grant : "";
		if (job.toLowerCase() === lower || grant.toLowerCase() === lower) taken(job);
	}
	if (Object.keys(registry).some((source) => source.toLowerCase() === lower)) taken(name);
}

const quoteValue = (value: string): string =>
	`"${sanitize(value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))}"`;

const quote = (part: string): string => {
	const text = sanitize(part);
	return text === "" || /[\s"'\\]/.test(text) ? quoteValue(part) : text;
};

export type RequestInput = {
	source: string;
	url: string;
	ref: string | null;
	sha: string;
	jobs: DeclaredJob[];
	credentials: Record<string, unknown>;
	requires: string[];
	build?: string[];
	existingState?: Record<string, string>;
};

const show = (value: unknown): string =>
	typeof value === "string" ? quoteValue(value) : String(value);

export function formatRequest(input: RequestInput): string {
	const lines = [
		`source: ${sanitize(input.source)}`,
		`url: ${sanitize(displayUrl(input.url))}`,
		`ref: ${input.ref === null ? "(default branch)" : sanitize(input.ref)}`,
		`sha: ${input.sha}`,
	];
	for (const { name, entry } of input.jobs) {
		const mode = MODE_KEYS.find((key) => Object.hasOwn(entry, key)) ?? "continuous";
		lines.push(
			`job ${sanitize(name)}`,
			`  argv: ${(entry.argv as string[]).map(quote).join(" ")}`,
			`  ${mode}: ${show(entry[mode])}`,
		);
		for (const key of ["feed", "notify", "timeoutMs", "envFile", "stopTimeoutMs"]) {
			if (entry[key] !== undefined) lines.push(`  ${key}: ${show(entry[key])}`);
		}
		const kept = input.existingState?.[name];
		if (kept !== undefined) {
			lines.push(`  ${sanitize(`state folder exists: ${kept} (kept from an earlier job)`)}`);
		}
	}
	lines.push(`credential prefix: ${sanitize(input.source)}/`);
	for (const credential of describeCredentials(input.jobs, input.credentials)) {
		const source = credential.source
			? `${credential.source.type} ${["secretId", "region", "key", "profile"]
					.filter((key) => credential.source?.[key] !== undefined)
					.map((key) => `${key}=${quoteValue(String(credential.source?.[key]))}`)
					.join(" ")}`
			: "none";
		lines.push(
			`credential ${sanitize(credential.name)}: ${credential.required ? "required" : "optional"}, prompt ${quoteValue(credential.prompt)}, source ${source}, used by ${credential.jobs.map(sanitize).join(", ")}`,
		);
		for (const [key, meta] of Object.entries(credential.meta)) {
			const fallback =
				meta.default === undefined ? "" : `, default ${quoteValue(meta.default)}`;
			lines.push(
				`  meta ${quoteValue(key)}: prompt ${quoteValue(meta.prompt)}${fallback}`,
			);
		}
	}
	if (input.requires.length > 0) {
		lines.push(`requires: ${input.requires.map(quote).join(", ")}`);
	}
	if (input.build) lines.push(`build: ${input.build.map(quote).join(" ")}`);
	return lines.join("\n");
}

const GIT_LOCAL_ENV = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_INTERNAL_SUPER_PREFIX",
];

function gitEnv(deps: JobVerbDeps): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		GIT_LFS_SKIP_SMUDGE: "1",
	};
	for (const name of GIT_LOCAL_ENV) delete env[name];
	if (!deps.isTerminal()) {
		env.GIT_TERMINAL_PROMPT = "0";
		env.GIT_SSH_COMMAND ??= "ssh -o BatchMode=yes";
	}
	return env;
}

const git = (deps: JobSourceDeps, args: string[], cwd?: string): Promise<GitResult> =>
	deps.runGit([...SAFE_GIT, ...args], {
		cwd,
		env: gitEnv(deps),
		stdin: deps.isTerminal() ? "inherit" : "ignore",
	});

const firstLine = (text: string): string =>
	text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "no output";

export async function resolveRef(
	deps: JobSourceDeps,
	cloneDir: string,
	ref: string | null,
	url: string,
): Promise<string> {
	const verify = async (name: string): Promise<string | undefined> => {
		const result = await git(
			deps,
			["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`],
			cloneDir,
		);
		const sha = result.stdout.trim();
		return result.code === 0 && FULL_SHA.test(sha) ? sha : undefined;
	};
	const found =
		ref === null
			? await verify("refs/remotes/origin/HEAD")
			: ((await verify(`refs/tags/${ref}`)) ?? (await verify(`refs/remotes/origin/${ref}`)));
	if (found) return found;
	if (ref !== null && FULL_SHA.test(ref)) {
		const exists = await git(deps, ["cat-file", "-e", `${ref}^{commit}`], cloneDir);
		if (exists.code === 0) return ref;
	}
	return stop(`ref "${ref ?? "HEAD"}" does not resolve in ${displayUrl(url)}`);
}

function insideClone(cloneDir: string, path: string, outside: string): void {
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return stop(`executable not found: ${path}`);
	}
	if (!insideRoot(realpathSync(cloneDir), real)) stop(outside);
	if (!statSync(real).isFile()) stop(`executable not found: ${path}`);
	try {
		accessSync(real, constants.X_OK);
	} catch {
		stop(`file is not executable: ${path}`);
	}
}

const hasSeparator = (name: string): boolean =>
	name.includes("/") || (process.platform === "win32" && name.includes("\\"));

function onInterrupt(cleanup: () => void): () => void {
	let stopping = false;
	const handlers = (
		[
			["SIGINT", 130],
			["SIGTERM", 143],
			["SIGHUP", 129],
		] as const
	).map(([signal, code]) => {
		const handler = async () => {
			if (stopping) return;
			stopping = true;
			const children = [...activeChildren];
			for (const child of children) child.kill();
			await Promise.race([
				Promise.allSettled(children.map((child) => child.exited)),
				Bun.sleep(CHILD_EXIT_WAIT_MS),
			]);
			cleanup();
			process.exit(code);
		};
		process.on(signal, handler);
		return [signal, handler] as const;
	});
	return () => {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	};
}

function snapshotOf(file: string): () => void {
	const bytes = existsSync(file) ? readFileSync(file) : undefined;
	return () => {
		if (bytes === undefined) rmSync(file, { force: true });
		else writeFilePreserving(file, bytes, 0o600);
	};
}

type Resolved = { jobs: DeclaredJob[]; inClone: { name: string; path: string }[] };

function resolveJobs(deps: JobSourceDeps, cloneDir: string, jobs: DeclaredJob[]): Resolved {
	const inClone: Resolved["inClone"] = [];
	const resolved = jobs.map(({ name, entry }) => {
		const [first, ...rest] = entry.argv as string[];
		if (!hasSeparator(first)) {
			return {
				name,
				entry: { ...entry, argv: [resolveExecutable(first, "job add:", deps.which), ...rest] },
			};
		}
		const path = resolve(cloneDir, first);
		inClone.push({ name, path });
		return { name, entry: { ...entry, argv: [path, ...rest] } };
	});
	return { jobs: resolved, inClone };
}

function resolveBuild(deps: JobSourceDeps, cloneDir: string, build: string[]): string[] {
	const [first, ...rest] = build;
	if (!hasSeparator(first)) return [resolveExecutable(first, "job add:", deps.which), ...rest];
	const path = resolve(cloneDir, first);
	const outside = '"build" must stay inside the repository';
	if (!insideRoot(cloneDir, path)) stop(outside);
	insideClone(cloneDir, path, outside);
	return [path, ...rest];
}

async function readBlock(
	deps: JobSourceDeps,
	cloneDir: string,
	sha: string,
	url: string,
): Promise<unknown> {
	const listing = await git(deps, ["ls-tree", "-l", "-z", sha, "--", "package.json"], cloneDir);
	const [header] = listing.stdout.split("\t");
	const [mode, , , size] = header.trim().split(/\s+/);
	if (listing.code !== 0 || !mode) stop(`${displayUrl(url)} has no package.json`);
	if (!mode.startsWith("100")) stop("package.json is not a regular file");
	if (Number(size) > MAX_PACKAGE_JSON_BYTES) stop("package.json is larger than 256 KiB");
	const shown = await git(deps, ["show", `${sha}:package.json`], cloneDir);
	if (shown.code !== 0) stop(`${displayUrl(url)} has no package.json`);
	try {
		return JSON.parse(shown.stdout);
	} catch {
		return stop("package.json is not valid JSON");
	}
}

function readState(paths: DgPaths): { config: Record<string, unknown>; registry: SourceRegistry } {
	return guardConfig(() => ({
		config: readConfigStrict(paths),
		registry: readSources(paths),
	}));
}

const alreadyAdded = (source: string, record: GitSourceRecord): never =>
	stop(
		`source "${source}" is already added from ${displayUrl(record.url)} — run dg job update ${record.jobs[0]}`,
	);

function commitToDisk(
	paths: DgPaths,
	source: string,
	record: GitSourceRecord,
	jobs: DeclaredJob[],
): void {
	const config = guardConfig(() => readConfigStrict(paths));
	requireMigrated(config);
	const registry = guardConfig(() => readSources(paths));
	if (registry[source]) alreadyAdded(source, registry[source]);
	for (const { name } of jobs) {
		if (isInTable(config, name)) stop(`a job named "${name}" already exists`);
	}
	assertPrefixFree(source, config, registry, "job add:");
	const restores = [snapshotOf(paths.daemonConfigPath), snapshotOf(paths.jobSourcesPath)];
	try {
		guardConfig(() => {
			writeSource(paths, source, record);
			for (const { name, entry } of jobs) writeJobEntry(paths, name, entry);
			for (const { name } of jobs) ensurePrivateDir(jobStateDir(paths, name));
		});
	} catch (err) {
		const failures: string[] = [];
		for (const restore of restores) {
			try {
				restore();
			} catch (restoreErr) {
				failures.push(describeError(restoreErr));
			}
		}
		if (failures.length === 0) throw err;
		throw new RollbackFailure(
			`${describeError(err)}; the rollback also failed: ${failures.join("; ")} — check ${paths.daemonConfigPath} and ${paths.jobSourcesPath}; the clone stays at ${jobSourceDir(paths, source)}`,
			EXIT_GENERAL_FAILURE,
		);
	}
}

async function addGit(
	argument: string,
	rest: string[],
	ownedFlags: string[],
	options: SourceAddOptions,
	deps: JobSourceDeps,
): Promise<void> {
	refuseCredentialsInUrl(argument);
	if (ownedFlags.length > 0) stop('the repository declares this in its "dg" block');
	if (rest.length > 0) stop("a URL takes no command after --");
	const { url, ref } = splitGitArgument(argument);
	if (url.startsWith("-") || ref?.startsWith("-")) {
		stop('a URL or a ref cannot start with "-"');
	}
	const source = sourceNameOf(url, options);
	const paths = resolveDgPaths();
	const { config, registry } = readState(paths);
	if (registry[source]) alreadyAdded(source, registry[source]);
	assertPrefixFree(source, config, registry, "job add:");
	const cloneDir = jobSourceDir(paths, source);
	if (existsSync(cloneDir) || lstatExists(cloneDir)) {
		stop(`${cloneDir} already exists — remove it, then run the command again`);
	}
	if (!deps.which("git")) stop("git is not installed");

	let madeClone = false;
	let keepClone = false;
	const removeClone = () => {
		if (madeClone) removeInside(paths.jobsDir, cloneDir);
	};
	const release = onInterrupt(() => {
		try {
			removeClone();
		} catch {}
	});
	let finished = false;
	try {
		ensurePrivateDir(paths.jobsDir);
		try {
			mkdirSync(cloneDir, { mode: 0o700 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			stop(`${cloneDir} already exists — remove it, then run the command again`);
		}
		madeClone = true;
		const clone = await git(deps, [
			"clone",
			"--quiet",
			"--no-recurse-submodules",
			"--",
			url,
			cloneDir,
		]);
		if (clone.code !== 0) {
			stop(
				`git clone failed: ${firstLine(clone.stderr).replaceAll(url, displayUrl(url))}`,
			);
		}
		const sha = await resolveRef(deps, cloneDir, ref, url);
		const checkout = await git(deps, ["checkout", "--detach", sha, "--"], cloneDir);
		if (checkout.code !== 0) stop(`git checkout failed: ${firstLine(checkout.stderr)}`);
		const head = (await git(deps, ["rev-parse", "HEAD"], cloneDir)).stdout.trim();
		if (!FULL_SHA.test(head)) stop("git did not give a full commit id");

		const pkg = await readBlock(deps, cloneDir, head, url);
		if (!isRecord(pkg) || !Object.hasOwn(pkg, "dg")) {
			stop(`${displayUrl(url)} has no "dg" key in package.json`);
		}
		const declaration = parseJobDeclaration(pkg, {
			source,
			sourceDir: cloneDir,
			stateDir: (name) => jobStateDir(paths, name),
		});
		if (!declaration.ok) return stop(declaration.error);
		if (declaration.jobs.length === 0) stop(`${displayUrl(url)} declares no jobs`);
		for (const { name } of declaration.jobs) {
			if (isInTable(config, name)) stop(`a job named "${name}" already exists`);
		}

		const missing = declaration.requires.filter((name) => !deps.which(name));
		if (missing.length > 0) {
			stop(`required executable(s) do not resolve on PATH: ${missing.join(", ")}`);
		}
		const resolved = resolveJobs(deps, cloneDir, declaration.jobs);
		const build =
			declaration.build && resolveBuild(deps, cloneDir, declaration.build);

		console.log(
			formatRequest({
				source,
				url,
				ref,
				sha: head,
				jobs: resolved.jobs,
				credentials: declaration.credentials,
				requires: declaration.requires,
				build,
				existingState: Object.fromEntries(
					resolved.jobs
						.map(({ name }) => [name, jobStateDir(paths, name)] as const)
						.filter(([, dir]) => existsSync(dir)),
				),
			}),
		);
		if (options.yes !== true) {
			if (!deps.isTerminal()) {
				stop("consent needs a terminal — run this command in a terminal yourself, or give --yes");
			}
			if (!(await deps.confirm(CONSENT_QUESTION))) {
				stop("declined; nothing was added");
			}
		}

		if (build && declaration.build) {
			let code: number;
			try {
				code = await deps.runBuild(build, cloneDir);
			} catch {
				return stop(`build did not start: ${declaration.build[0]}`);
			}
			if (code !== 0) {
				stop(`build failed (exit ${code}): ${declaration.build.join(" ")}`);
			}
		}
		for (const { name, path } of resolved.inClone) {
			insideClone(cloneDir, path, `job "${name}": "argv" must stay inside the repository`);
		}

		await ensureMigrated(paths);
		release();
		const record: GitSourceRecord = {
			kind: "git",
			url,
			ref,
			sha: head,
			jobs: resolved.jobs.map(({ name }) => name),
			declarationHash: declarationHash(pkg.dg),
			credentials: declaration.credentials,
		};
		try {
			await withConfigLock(paths, () => commitToDisk(paths, source, record, resolved.jobs));
		} catch (err) {
			keepClone = err instanceof RollbackFailure;
			throw err;
		}
		finished = true;

		console.log(
			`added jobs from "${source}" at ${head.slice(0, 12)}: ${record.jobs.join(", ")}`,
		);
		for (const name of record.jobs) console.log(`next: dg job enable ${name}`);
		for (const { name, entry } of resolved.jobs) {
			const file = entry.envFile;
			if (typeof file === "string" && !existsSync(file)) {
				console.log(
					sanitize(`next: create ${file} with mode 600 before you start ${name}`),
				);
			}
		}
	} finally {
		release();
		if (!finished && !keepClone) {
			try {
				removeClone();
			} catch (err) {
				console.error(`warning: could not remove ${cloneDir}: ${describeError(err)}`);
			}
		}
	}
}

function lstatExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Adds the jobs of one positional argument: a repository URL now, a local path in a later slice. */
export async function addSource(
	argument: string,
	rest: string[],
	ownedFlags: string[],
	options: SourceAddOptions,
	deps: JobSourceDeps,
): Promise<void> {
	if (classifySource(argument) === "path") {
		stop("a local path is not supported yet");
	}
	await addGit(argument, rest, ownedFlags, options, deps);
}

/** Takes one job out of its record; the last job removes the record, then the clone. */
export function removeJobFromSource(paths: DgPaths, job: string): void {
	const found = findRecordByJob(readSources(paths), job);
	if (!found) return;
	const remaining = found.record.jobs.filter((name) => name !== job);
	if (remaining.length > 0) {
		writeSource(paths, found.source, { ...found.record, jobs: remaining });
		return;
	}
	writeSource(paths, found.source, undefined);
	removeInside(paths.jobsDir, jobSourceDir(paths, found.source));
}
