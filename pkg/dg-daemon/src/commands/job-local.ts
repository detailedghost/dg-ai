import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
	DgCliError,
	EXIT_GENERAL_FAILURE,
} from "@dg/common";
import {
	type DgPaths,
	isJobName,
	jobStateDir,
	resolveDgPaths,
} from "@dg/common/node";
import { JOB_NAME_RULE, parseJobEntry } from "../jobs/config";
import { declarationHash, describeCredentials, type DeclaredJob } from "../jobs/declaration";
import { sanitize } from "../jobs/sanitize";
import { findRecordByJob, type PathSourceRecord, writeSource } from "../jobs/sources";
import { writeJobEntry } from "../server/config-store";
import {
	alreadyAdded,
	assertPrefixFree,
	commitToDisk,
	credentialLines,
	credentialListFor,
	formatRequest,
	insideClone,
	type JobSourceDeps,
	onInterrupt,
	readFolderDeclared,
	readState,
	resolveBuild,
	resetSetupOnSourceChange,
	resolveJobs,
	rollBack,
	snapshotOf,
	stateFoldersOf,
	type SourceAddOptions,
	stop,
} from "./job-source";
import { assertOneMode, checkEntryFlags, entryFromFlags, type EntryFlags } from "./job-entry";
import { refuseLiveJobs, writeBlockEntries } from "./job-update";
import {
	assertNoLiveInstance,
	ensureMigrated,
	guardConfig,
	isInTable,
	liveJobStates,
	requireMigrated,
	withConfigLock,
} from "./job-support";

export type LocalAddOptions = SourceAddOptions & EntryFlags & { credential?: string[] };

const SCRIPT_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];
const UPDATE_PREFIX = "job update:";
const say = (text: string): void => console.log(sanitize(text));

function locate(argument: string): { given: string; real: string } {
	let text = argument;
	if (argument === "~" || argument.startsWith("~/")) text = join(process.env.HOME || homedir(), argument.slice(1));
	else if (argument.startsWith("~")) stop("only ~ and ~/ are supported");
	const given = resolve(text);
	try {
		return { given, real: realpathSync(given) };
	} catch {
		return stop(`no file or folder at ${given}`);
	}
}

function isExecutable(file: string): boolean {
	if (process.platform === "win32") return false;
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function fileArgv(real: string, rest: string[], deps: JobSourceDeps): string[] {
	if (isExecutable(real)) return [real, ...rest];
	if (!SCRIPT_EXTENSIONS.includes(extname(real).toLowerCase())) {
		stop(
			`${real} is not executable — run chmod +x, or use dg job add --name <name> --cwd <dir> <mode> -- <command>`,
		);
	}
	const bun = deps.which("bun");
	if (!bun) stop(`bun is not installed — it is necessary to run ${real}`);
	return [resolve(bun as string), real, ...rest];
}

function fileEntry(
	real: string,
	name: string,
	rest: string[],
	options: LocalAddOptions,
	deps: JobSourceDeps,
): Record<string, unknown> {
	assertOneMode(options, "job add");
	const parts = checkEntryFlags(options, "job add");
	const argv = fileArgv(real, rest, deps);
	const entry = entryFromFlags(options, parts, {
		argv,
		cwd: dirname(real),
		credentials: credentialListFor(options.credential, name),
	});
	const parsed = parseJobEntry(name, entry);
	if (!parsed.ok) stop(parsed.error);
	return entry;
}

async function addFile(
	given: string,
	real: string,
	rest: string[],
	flags: string[],
	options: LocalAddOptions,
	deps: JobSourceDeps,
): Promise<void> {
	if (flags.includes("cwd")) stop("the folder of the file is its working directory");
	const explicit = options.name;
	const stem = basename(given, extname(given));
	const name = explicit ?? stem.toLowerCase();
	if (!isJobName(name)) {
		stop(
			explicit === undefined
				? `cannot use "${stem}" as a job name — give one with --name`
				: `"--name" ${JOB_NAME_RULE}`,
		);
	}
	const entry = fileEntry(real, name, rest, options, deps);
	const paths = resolveDgPaths();
	const { config, registry } = readState(paths);
	if (isInTable(config, name)) {
		stop(`a job named "${name}" already exists — to change it, run dg job update ${name}`);
	}
	assertPrefixFree(name, config, registry, "job add:");
	await ensureMigrated(paths);
	const record: PathSourceRecord = { kind: "path", path: real, jobs: [name], credentials: {} };
	await withConfigLock(paths, () => commitToDisk(paths, name, record, [{ name, entry }]));

	if (real !== given) say(`stored real path ${real}`);
	say(`added job "${name}" from ${real}`);
	say(`next: dg job enable ${name}`);
	say(
		"after you edit the script, no dg command is needed — a scheduled job uses the new text at its next run, a continuous job at its next start",
	);
}

async function addFolder(
	given: string,
	real: string,
	rest: string[],
	flags: string[],
	options: LocalAddOptions,
	deps: JobSourceDeps,
): Promise<void> {
	if (flags.length > 0) stop('the folder declares this in its "dg" block');
	if (rest.length > 0) stop("a folder takes no command after --");
	const explicit = options.name;
	const stem = basename(given);
	const source = explicit ?? stem.toLowerCase();
	if (!isJobName(source)) stop(`cannot use "${explicit ?? stem}" as a source name — give one with --name`);
	const paths = resolveDgPaths();
	const { config, registry } = readState(paths);
	if (registry[source]) alreadyAdded(source, registry[source]);
	assertPrefixFree(source, config, registry, "job add:");
	const { pkg, declaration } = readFolderDeclared(paths, source, real, "job add:");
	for (const { name } of declaration.jobs) {
		if (isInTable(config, name)) stop(`a job named "${name}" already exists`);
	}
	const missing = declaration.requires.filter((name) => !deps.which(name));
	if (missing.length > 0) {
		stop(`required executable(s) do not resolve on PATH: ${missing.join(", ")}`);
	}
	const resolved = resolveJobs(deps, real, declaration.jobs);
	const build = declaration.build && resolveBuild(deps, real, declaration.build);
	console.log(
		formatRequest({
			source,
			path: real,
			jobs: resolved.jobs,
			credentials: declaration.credentials,
			requires: declaration.requires,
			build,
			existingState: stateFoldersOf(paths, resolved.jobs.map(({ name }) => name)),
		}),
	);

	if (build && declaration.build) {
		const release = onInterrupt(() => {});
		try {
			let code: number;
			try {
				code = await deps.runBuild(build, real);
			} catch {
				return stop(`build did not start: ${declaration.build[0]}`);
			}
			if (code !== 0) stop(`build failed (exit ${code}): ${declaration.build.join(" ")}`);
		} finally {
			release();
		}
	}
	for (const { name, path } of resolved.inClone) {
		insideClone(real, path, `job "${name}": "argv" must stay inside the repository or folder`);
	}

	await ensureMigrated(paths);
	const record: PathSourceRecord = {
		kind: "path",
		path: real,
		jobs: resolved.jobs.map(({ name }) => name),
		declarationHash: declarationHash(pkg.dg),
		credentials: declaration.credentials,
	};
	await withConfigLock(paths, () => commitToDisk(paths, source, record, resolved.jobs));

	if (real !== given) say(`stored real path ${real}`);
	say(`added jobs from "${source}" at ${real}: ${record.jobs.join(", ")}`);
	for (const name of record.jobs) say(`next: dg job enable ${name}`);
	for (const { name, entry } of resolved.jobs) {
		const file = entry.envFile;
		if (typeof file === "string" && !existsSync(file)) {
			say(`next: create ${file} with mode 600 before you start ${name}`);
		}
	}
}

/** Adds one local file as a job, or the jobs that the `dg` block of one local folder declares. */
export async function addLocal(
	argument: string,
	rest: string[],
	flags: string[],
	options: LocalAddOptions,
	deps: JobSourceDeps,
): Promise<void> {
	const { given, real } = locate(argument);
	if (statSync(real).isDirectory()) {
		await addFolder(given, real, rest, flags, options, deps);
		return;
	}
	await addFile(given, real, rest, flags, options, deps);
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function declaredJobsOf(config: Record<string, unknown>, names: string[]): DeclaredJob[] {
	const table = config.jobs as Record<string, unknown> | undefined;
	return names.flatMap((name) => {
		const entry = table?.[name];
		return typeof entry === "object" && entry !== null
			? [{ name, entry: entry as Record<string, unknown> }]
			: [];
	});
}

/** Reads the `dg` block of a local folder again and rewrites the entries of its jobs. */
export async function updateLocal(name: string, deps: JobSourceDeps): Promise<void> {
	const paths = resolveDgPaths();
	if (existsSync(paths.daemonConfigPath)) await ensureMigrated(paths);
	const first = readState(paths);
	const found = findRecordByJob(first.registry, name);
	if (found?.record.kind !== "path" || found.record.declarationHash === undefined) {
		throw new DgCliError(`no job named "${name}"`, EXIT_GENERAL_FAILURE);
	}
	const { source, record } = found as { source: string; record: PathSourceRecord };
	if (!existsSync(record.path)) stop(`no folder at ${record.path}`, UPDATE_PREFIX);
	const { pkg, declaration } = readFolderDeclared(paths, source, record.path, UPDATE_PREFIX);
	const known = new Set(record.jobs);
	const names = declaration.jobs.map((job) => job.name);
	const clash = (config: Record<string, unknown>) => {
		for (const job of names) {
			if (!known.has(job) && isInTable(config, job)) stop(`a job named "${job}" already exists`, UPDATE_PREFIX);
		}
	};
	clash(first.config);
	const missing = declaration.requires.filter((required) => !deps.which(required));
	if (missing.length > 0) {
		stop(`required executable(s) do not resolve on PATH: ${missing.join(", ")}`, UPDATE_PREFIX);
	}
	const resolved = resolveJobs(deps, record.path, declaration.jobs, UPDATE_PREFIX);
	if (declaration.build) resolveBuild(deps, record.path, declaration.build, UPDATE_PREFIX, false);
	for (const { name: job, path } of resolved.inClone) {
		insideClone(
			record.path,
			path,
			`job "${job}": "argv" must stay inside the repository or folder`,
			UPDATE_PREFIX,
		);
	}
	const before = describeCredentials(declaredJobsOf(first.config, record.jobs), record.credentials);
	const removed = record.jobs.filter((job) => !names.includes(job));
	const marks = resetSetupOnSourceChange(record, declaration.credentials, declaration.jobs);
	const next: PathSourceRecord = {
		...record,
		declarationHash: declarationHash(pkg.dg),
		jobs: names,
		credentials: declaration.credentials,
		...(marks.setupDone === undefined ? {} : { setupDone: marks.setupDone }),
	};
	let outcome = { replaced: [] as string[], created: [] as string[] };

	await withConfigLock(paths, async () => {
		const state = readState(paths);
		requireMigrated(state.config);
		const stored = state.registry[source];
		if (stored?.kind !== "path" || !sameValue(stored.jobs, record.jobs)) {
			stop("the source or the daemon config changed — nothing was changed", UPDATE_PREFIX);
		}
		clash(state.config);
		for (const job of removed) assertNoLiveInstance(paths, job);
		if (removed.length > 0) await refuseLiveJobs(paths, name, removed);
		const restores = [snapshotOf(paths.daemonConfigPath), snapshotOf(paths.jobSourcesPath)];
		try {
			guardConfig(() => {
				outcome = writeBlockEntries(paths, state.config, resolved.jobs);
				for (const job of removed) {
					if (isInTable(state.config, job)) writeJobEntry(paths, job, undefined);
				}
				writeSource(paths, source, next);
			});
		} catch (err) {
			rollBack(err, restores, paths, source, "");
		}
	});

	say(`updated source "${source}" at ${record.path}`);
	for (const line of outcome.replaced) say(line);
	for (const job of outcome.created) say(`next: dg job enable ${job}`);
	for (const job of marks.reset) say(`next: dg job setup ${job}`);
	if (declaration.build) {
		say(`build was not run — run ${declaration.build.join(" ")} yourself in ${record.path}`);
	}
	const was = new Map(before.map((credential) => [credential.name, credentialLines(credential)]));
	for (const credential of describeCredentials(declaration.jobs, declaration.credentials)) {
		const lines = credentialLines(credential);
		if (!sameValue(was.get(credential.name), lines)) say(`changed ${lines[0]}`);
	}
	const states = await liveJobStates(paths).catch(() => undefined);
	for (const job of names) {
		const active = states?.get(job);
		const changed = outcome.replaced.some((line) => line.startsWith(`replaced ${job}.`));
		if (changed && (active === "running" || active === "backoff")) {
			say(`next: dg job restart ${job}`);
		}
	}
}
