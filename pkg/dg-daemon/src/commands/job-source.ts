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
import { join, resolve } from "node:path";
import { exitAfterDrain } from "@dg/common/async";
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
import { envNameProblem, JOBS_CONFIG_KEY, MAX_ENV_NAME } from "../jobs/config";
import { ENV_KEY } from "../services/env-file";
import {
	type Declaration,
	type DeclaredCredential,
	type DeclaredJob,
	declarationHash,
	describeCredentials,
	parseJobDeclaration,
} from "../jobs/declaration";
import { sanitize } from "../jobs/sanitize";
import {
	findMarkRecord,
	findRecordByJob,
	type GitSourceRecord,
	type PathSourceRecord,
	readSourceRecords,
	readNamedSources,
	type NamedRegistry,
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
export const SAFE_GIT = ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never"];
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP = /^[^/\\]+@[^/\\:]+:/;
const DRIVE = /^[a-zA-Z]:[\\/]/;
export const FULL_SHA = /^[0-9a-f]{40}$/;
export const MODE_KEYS = ["continuous", "schedule", "every"];

function fail(message: string): never {
	throw new DgCliError(message, EXIT_GENERAL_FAILURE);
}

export function stop(message: string, prefix = "job add:"): never {
	return fail(sanitize(`${prefix} ${message}`));
}

type Child = { kill(): void; exited: Promise<number> };

const activeChildren = new Set<Child>();
const CHILD_EXIT_WAIT_MS = 2000;

export class RollbackFailure extends DgCliError {}

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
	registry: NamedRegistry,
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

/** Reads the --credential values of an add or an update; dg sets the grant to the job name. */
const ENV_TEXT_RULE =
	"--credential: the text after = must be a variable name such as API_KEY";

export function credentialListFor(
	flagValues: string[] | undefined,
	jobName: string,
): { credentials?: string[]; grant?: string; credentialEnv?: Record<string, string> } {
	if (flagValues === undefined || flagValues.length === 0) return {};
	const names = new Set<string>();
	const bound = new Map<string, string>();
	for (const value of flagValues) {
		const at = value.indexOf("=");
		const name = (at < 0 ? value : value.slice(0, at)).toLowerCase();
		if (name === "") fail("--credential takes a name");
		names.add(name);
		if (at < 0) continue;
		const variable = value.slice(at + 1);
		if (variable.length > MAX_ENV_NAME || !ENV_KEY.test(variable)) {
			fail(ENV_TEXT_RULE);
		}
		const problem = envNameProblem(variable);
		if (problem) fail(`--credential ${name}: ${problem}`);
		const earlier = bound.get(variable);
		if (earlier !== undefined && earlier !== name) {
			fail(`environment variable ${JSON.stringify(variable)} is bound to two credentials`);
		}
		bound.set(variable, name);
	}
	return {
		credentials: [...names],
		grant: jobName,
		...(bound.size === 0 ? {} : { credentialEnv: Object.fromEntries(bound) }),
	};
}

const quoteValue = (value: string): string =>
	`"${sanitize(value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))}"`;

export const quote = (part: string): string => {
	const text = sanitize(part);
	return text === "" || /[\s"'\\]/.test(text) ? quoteValue(part) : text;
};

export type RequestInput = {
	source: string;
	url?: string;
	ref?: string | null;
	sha?: string;
	path?: string;
	jobs: DeclaredJob[];
	credentials: Record<string, unknown>;
	requires: string[];
	build?: string[];
	existingState?: Record<string, string>;
};

export const show = (value: unknown): string =>
	typeof value === "string" ? quoteValue(value) : String(value);

export function credentialLines(credential: DeclaredCredential): string[] {
	const source = credential.source
		? `${credential.source.type} ${["secretId", "region", "key", "profile"]
				.filter((key) => credential.source?.[key] !== undefined)
				.map((key) => `${key}=${quoteValue(String(credential.source?.[key]))}`)
				.join(" ")}`
		: "none";
	const lines = [
		`credential ${sanitize(credential.name)}: ${credential.required ? "required" : "optional"}, prompt ${quoteValue(credential.prompt)}, source ${source}, used by ${credential.jobs.map(sanitize).join(", ")}${credential.env === undefined ? "" : `, → env ${sanitize(credential.env)} (required at launch)`}`,
	];
	for (const [key, meta] of Object.entries(credential.meta)) {
		const fallback = meta.default === undefined ? "" : `, default ${quoteValue(meta.default)}`;
		lines.push(`  meta ${quoteValue(key)}: prompt ${quoteValue(meta.prompt)}${fallback}`);
	}
	return lines;
}

export function formatRequest(input: RequestInput): string {
	const lines = [
		`source: ${sanitize(input.source)}`,
		...(input.path === undefined
			? [
					`url: ${sanitize(displayUrl(input.url ?? ""))}`,
					`ref: ${input.ref == null ? "(default branch)" : sanitize(input.ref)}`,
					`sha: ${input.sha}`,
				]
			: [`path: ${sanitize(input.path)}`]),
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
		lines.push(...credentialLines(credential));
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

export function gitEnv(deps: JobVerbDeps): Record<string, string | undefined> {
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

export const git = (deps: JobSourceDeps, args: string[], cwd?: string): Promise<GitResult> =>
	deps.runGit([...SAFE_GIT, ...args], {
		cwd,
		env: gitEnv(deps),
		stdin: deps.isTerminal() ? "inherit" : "ignore",
	});

export const firstLine = (text: string): string =>
	text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "no output";

export async function findRef(
	deps: JobSourceDeps,
	cloneDir: string,
	ref: string | null,
): Promise<string | undefined> {
	const verify = async (name: string): Promise<string | undefined> => {
		const result = await git(
			deps,
			["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`],
			cloneDir,
		);
		const sha = result.stdout.trim();
		return result.code === 0 && FULL_SHA.test(sha) ? sha : undefined;
	};
	if (ref !== null && FULL_SHA.test(ref)) {
		const exists = await git(deps, ["cat-file", "-e", `${ref}^{commit}`], cloneDir);
		return exists.code === 0 ? ref : undefined;
	}
	return ref === null
		? verify("refs/remotes/origin/HEAD")
		: ((await verify(`refs/tags/${ref}`)) ?? (await verify(`refs/remotes/origin/${ref}`)));
}

export async function resolveRef(
	deps: JobSourceDeps,
	cloneDir: string,
	ref: string | null,
	url: string,
): Promise<string> {
	return (
		(await findRef(deps, cloneDir, ref)) ??
		stop(`ref "${ref ?? "HEAD"}" does not resolve in ${displayUrl(url)}`)
	);
}

export function insideClone(
	cloneDir: string,
	path: string,
	outside: string,
	prefix = "job add:",
): void {
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return stop(`executable not found: ${path}`, prefix);
	}
	if (!insideRoot(realpathSync(cloneDir), real)) stop(outside, prefix);
	if (!statSync(real).isFile()) stop(`executable not found: ${path}`, prefix);
	try {
		accessSync(real, constants.X_OK);
	} catch {
		stop(`file is not executable: ${path}`, prefix);
	}
}

const hasSeparator = (name: string): boolean =>
	name.includes("/") || (process.platform === "win32" && name.includes("\\"));

export function onInterrupt(cleanup: () => void): () => void {
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
			await exitAfterDrain(code);
		};
		process.on(signal, handler);
		return [signal, handler] as const;
	});
	return () => {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	};
}

export function snapshotOf(file: string): () => void {
	const bytes = existsSync(file) ? readFileSync(file) : undefined;
	return () => {
		if (bytes === undefined) rmSync(file, { force: true });
		else writeFilePreserving(file, bytes, 0o600);
	};
}

export type Resolved = { jobs: DeclaredJob[]; inClone: { name: string; path: string }[] };

export function resolveJobs(
	deps: JobSourceDeps,
	cloneDir: string,
	jobs: DeclaredJob[],
	prefix = "job add:",
): Resolved {
	const inClone: Resolved["inClone"] = [];
	const resolved = jobs.map(({ name, entry }) => {
		const [first, ...rest] = entry.argv as string[];
		if (!hasSeparator(first)) {
			return {
				name,
				entry: { ...entry, argv: [resolveExecutable(first, prefix, deps.which), ...rest] },
			};
		}
		const path = resolve(cloneDir, first);
		inClone.push({ name, path });
		return { name, entry: { ...entry, argv: [path, ...rest] } };
	});
	return { jobs: resolved, inClone };
}

export function resolveBuild(
	deps: JobSourceDeps,
	cloneDir: string,
	build: string[],
	prefix = "job add:",
	verifyFile = true,
): string[] {
	const [first, ...rest] = build;
	if (!hasSeparator(first)) return [resolveExecutable(first, prefix, deps.which), ...rest];
	const path = resolve(cloneDir, first);
	const outside = '"build" must stay inside the repository';
	if (!insideRoot(cloneDir, path)) stop(outside, prefix);
	if (verifyFile) insideClone(cloneDir, path, outside, prefix);
	return [path, ...rest];
}

export async function readBlock(
	deps: JobSourceDeps,
	cloneDir: string,
	sha: string,
	url: string,
	prefix = "job add:",
): Promise<unknown> {
	const listing = await git(deps, ["ls-tree", "-l", "-z", sha, "--", "package.json"], cloneDir);
	const [header] = listing.stdout.split("\t");
	const [mode, , , size] = header.trim().split(/\s+/);
	if (listing.code !== 0 || !mode) stop(`${displayUrl(url)} has no package.json`, prefix);
	if (!mode.startsWith("100")) stop("package.json is not a regular file", prefix);
	if (Number(size) > MAX_PACKAGE_JSON_BYTES) stop("package.json is larger than 256 KiB", prefix);
	const shown = await git(deps, ["show", `${sha}:package.json`], cloneDir);
	if (shown.code !== 0) stop(`${displayUrl(url)} has no package.json`, prefix);
	try {
		return JSON.parse(shown.stdout);
	} catch {
		return stop("package.json is not valid JSON", prefix);
	}
}

export type DeclaredAt = { paths: DgPaths; source: string; cloneDir: string; url: string };

export async function readDeclared(
	deps: JobSourceDeps,
	at: DeclaredAt,
	sha: string,
	prefix: string,
): Promise<{
	pkg: { dg: unknown };
	declaration: Extract<Declaration, { ok: true }>;
}> {
	const pkg = await readBlock(deps, at.cloneDir, sha, at.url, prefix);
	if (!isRecord(pkg) || !Object.hasOwn(pkg, "dg")) {
		stop(`${displayUrl(at.url)} has no "dg" key in package.json`, prefix);
	}
	const declaration = parseJobDeclaration(pkg, {
		source: at.source,
		sourceDir: at.cloneDir,
		stateDir: (name) => jobStateDir(at.paths, name),
	});
	if (!declaration.ok) return stop(declaration.error, prefix);
	if (declaration.jobs.length === 0) stop(`${displayUrl(at.url)} declares no jobs`, prefix);
	return { pkg: pkg as { dg: unknown }, declaration };
}

export function readState(paths: DgPaths): { config: Record<string, unknown>; registry: NamedRegistry } {
	return guardConfig(() => ({
		config: readConfigStrict(paths),
		registry: readNamedSources(paths),
	}));
}

export const alreadyAdded = (source: string, record: GitSourceRecord | PathSourceRecord): never =>
	stop(
		`source "${source}" is already added from ${record.kind === "git" ? displayUrl(record.url) : record.path} — run dg job update ${record.jobs[0]}`,
	);

export function rollBack(
	err: unknown,
	restores: (() => void)[],
	paths: DgPaths,
	source: string,
	kept = `; the clone stays at ${jobSourceDir(paths, source)}`,
): never {
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
		`${describeError(err)}; the rollback also failed: ${failures.join("; ")} — check ${paths.daemonConfigPath} and ${paths.jobSourcesPath}${kept}`,
		EXIT_GENERAL_FAILURE,
	);
}

export function commitToDisk(
	paths: DgPaths,
	source: string,
	record: GitSourceRecord | PathSourceRecord,
	jobs: DeclaredJob[],
): void {
	const config = guardConfig(() => readConfigStrict(paths));
	requireMigrated(config);
	const registry = guardConfig(() => readNamedSources(paths));
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
		return rollBack(
			err,
			restores,
			paths,
			source,
			record.kind === "git" ? undefined : "",
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

		const { pkg, declaration } = await readDeclared(
			deps,
			{ paths, source, cloneDir, url },
			head,
			"job add:",
		);
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

/** Adds the jobs of one repository URL; `classifySource` routes a path to job-local.ts first. */
export async function addSource(
	argument: string,
	rest: string[],
	ownedFlags: string[],
	options: SourceAddOptions,
	deps: JobSourceDeps,
): Promise<void> {
	await addGit(argument, rest, ownedFlags, options, deps);
}

const NO_BLOCK = (dir: string) => `${dir} has no package.json with a "dg" key`;

export function readFolderPackage(dir: string, prefix: string): { dg: unknown } {
	const file = join(dir, "package.json");
	let size: number;
	try {
		const info = statSync(file);
		if (!info.isFile()) return stop(NO_BLOCK(dir), prefix);
		size = info.size;
	} catch {
		return stop(NO_BLOCK(dir), prefix);
	}
	if (size > MAX_PACKAGE_JSON_BYTES) stop("package.json is larger than 256 KiB", prefix);
	let pkg: unknown;
	try {
		pkg = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return stop("package.json is not valid JSON", prefix);
	}
	if (!isRecord(pkg) || !Object.hasOwn(pkg, "dg")) return stop(NO_BLOCK(dir), prefix);
	return pkg as { dg: unknown };
}

export function readFolderDeclared(
	paths: DgPaths,
	source: string,
	dir: string,
	prefix: string,
): { pkg: { dg: unknown }; declaration: Extract<Declaration, { ok: true }> } {
	const pkg = readFolderPackage(dir, prefix);
	const declaration = parseJobDeclaration(pkg, {
		source,
		sourceDir: dir,
		stateDir: (name) => jobStateDir(paths, name),
	});
	if (!declaration.ok) return stop(declaration.error, prefix);
	if (declaration.jobs.length === 0) stop(`${dir} declares no jobs`, prefix);
	return { pkg, declaration };
}

export type SourceState = "ok" | "changed" | "missing" | "invalid";

export function sourceStateOf(paths: DgPaths, source: string, record: PathSourceRecord): SourceState {
	if (!existsSync(record.path)) return "missing";
	if (record.declarationHash === undefined) return "ok";
	try {
		const { pkg } = readFolderDeclared(paths, source, record.path, "job:");
		return declarationHash(pkg.dg) === record.declarationHash ? "ok" : "changed";
	} catch {
		return "invalid";
	}
}

/** Takes one job out of its record; the last job removes the record, then the clone. */
export function removeJobFromSource(paths: DgPaths, job: string): void {
	const registry = readSourceRecords(paths);
	const found = findRecordByJob(registry, job);
	if (!found) {
		if (findMarkRecord(registry, job)) writeSource(paths, job, undefined);
		return;
	}
	const remaining = found.record.jobs.filter((name) => name !== job);
	if (remaining.length > 0) {
		const done = found.record.setupDone?.filter((name) => name !== job);
		writeSource(paths, found.source, {
			...found.record,
			jobs: remaining,
			...(done === undefined ? {} : { setupDone: done }),
		});
		return;
	}
	writeSource(paths, found.source, undefined);
	if (found.record.kind === "git") removeInside(paths.jobsDir, jobSourceDir(paths, found.source));
}
