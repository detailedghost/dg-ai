import { existsSync } from "node:fs";
import { devNull } from "node:os";
import {
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	isRecord,
} from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	jobSourceDir,
	jobStateDir,
	resolveDgPaths,
} from "@dg/common/node";
import { JOBS_CONFIG_KEY } from "../jobs/config";
import { sanitize } from "../jobs/sanitize";
import {
	type DeclaredJob,
	declarationHash,
	describeCredentials,
} from "../jobs/declaration";
import { findRecordByJob, type GitSourceRecord, writeSource } from "../jobs/sources";
import { writeJobEntry } from "../server/config-store";
import {
	credentialLines,
	type DeclaredAt,
	displayUrl,
	FULL_SHA,
	findRef,
	firstLine,
	formatRequest,
	gitEnv,
	git,
	insideClone,
	type JobSourceDeps,
	onInterrupt,
	quote,
	readDeclared,
	readState,
	resolveBuild,
	resolveJobs,
	RollbackFailure,
	rollBack,
	SAFE_GIT,
	show,
	snapshotOf,
	stop as stopWith,
} from "./job-source";
import {
	assertDaemonAnswers,
	assertNoLiveInstance,
	guardConfig,
	isInTable,
	liveJobStates,
	requireMigrated,
	withConfigLock,
	ensureMigrated,
} from "./job-support";

const PREFIX = "job update:";
const HARDENED_GIT = ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false"];
const REPOSITORY_KEYS = [
	"argv",
	"cwd",
	"continuous",
	"schedule",
	"every",
	"feed",
	"notify",
	"timeoutMs",
	"credentials",
	"credentialEnv",
	"grant",
	"envFile",
	"stopTimeoutMs",
];

export type UpdateSourceOptions = { yes?: boolean };

type Declared = {
	jobs: DeclaredJob[];
	credentials: Record<string, unknown>;
	requires: string[];
	build: string[] | undefined;
};

const stop = (message: string): never => stopWith(message, PREFIX);

const sameValue = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

const emptyDeclared = (): Declared => ({
	jobs: [],
	credentials: {},
	requires: [],
	build: undefined,
});

async function readOldBlock(
	deps: JobSourceDeps,
	at: DeclaredAt,
	sha: string,
): Promise<Declared> {
	try {
		return (await readDeclared(deps, at, sha, PREFIX)).declaration;
	} catch {
		return emptyDeclared();
	}
}

/** Writes the repository keys of each job and keeps the keys that a block cannot set. */
export function writeBlockEntries(
	paths: DgPaths,
	config: Record<string, unknown>,
	jobs: DeclaredJob[],
): { replaced: string[]; created: string[] } {
	const table = isRecord(config[JOBS_CONFIG_KEY]) ? config[JOBS_CONFIG_KEY] : {};
	const replaced: string[] = [];
	const created: string[] = [];
	for (const { name, entry } of jobs) {
		const stored = (table as Record<string, unknown>)[name];
		if (!isRecord(stored)) {
			writeJobEntry(paths, name, entry);
			ensurePrivateDir(jobStateDir(paths, name));
			created.push(name);
			continue;
		}
		const kept = Object.fromEntries(
			Object.entries(stored).filter(([key]) => !REPOSITORY_KEYS.includes(key)),
		);
		const next = { ...kept, ...entry };
		for (const key of REPOSITORY_KEYS) {
			if (!sameValue(stored[key], next[key])) replaced.push(`replaced ${name}.${key}`);
		}
		writeJobEntry(paths, name, next);
	}
	return { replaced, created };
}

const list = (items: string[], separator: string): string =>
	items.length === 0 ? "(none)" : items.map(quote).join(separator);

const render = (value: unknown): string => {
	if (value === undefined) return "(none)";
	return Array.isArray(value) ? list(value as string[], " ") : show(value);
};

function credentialMap(declared: Declared): Map<string, string[]> {
	return new Map(
		describeCredentials(declared.jobs, declared.credentials).map((credential) => [
			credential.name,
			credentialLines(credential),
		]),
	);
}

function changedLines(old: Declared, next: Declared): string[] {
	const lines: string[] = [];
	const before = new Map(old.jobs.map(({ name, entry }) => [name, entry]));
	const after = new Set(next.jobs.map(({ name }) => name));
	for (const { name, entry } of next.jobs) {
		const was = before.get(name);
		if (!was) {
			lines.push(`new job ${name}`);
			continue;
		}
		for (const key of new Set([...Object.keys(was), ...Object.keys(entry)])) {
			if (!sameValue(was[key], entry[key])) {
				lines.push(`changed job ${name}.${key}: ${render(was[key])} -> ${render(entry[key])}`);
			}
		}
	}
	for (const { name } of old.jobs) {
		if (!after.has(name)) lines.push(`removed job ${name}`);
	}
	if (!sameValue(old.requires, next.requires)) {
		lines.push(`changed requires: ${list(old.requires, ", ")} -> ${list(next.requires, ", ")}`);
	}
	if (!sameValue(old.build, next.build)) {
		lines.push(
			`changed build: ${list(old.build ?? [], " ")} -> ${list(next.build ?? [], " ")}`,
		);
	}
	const was = credentialMap(old);
	const now = credentialMap(next);
	for (const name of new Set([...was.keys(), ...now.keys()])) {
		const oldLines = was.get(name);
		const newLines = now.get(name);
		if (sameValue(oldLines, newLines)) continue;
		lines.push(
			`changed credential ${sanitize(name)}`,
			...(oldLines ?? []).map((line) => `  was: ${line}`),
			...(newLines ?? []).map((line) => `  now: ${line}`),
		);
	}
	return lines;
}

function refuseActive(states: Map<string, string> | undefined, names: string[]): void {
	for (const name of names) {
		const state = states?.get(name);
		if (state === "running" || state === "backoff") {
			throw new DgCliError(
				`job "${name}" is ${state} — stop it first with dg job stop ${name}`,
				EXIT_GENERAL_FAILURE,
			);
		}
	}
}

export async function refuseLiveJobs(paths: DgPaths, via: string, names: string[]): Promise<void> {
	if (await assertDaemonAnswers(paths, via, "job")) {
		refuseActive(await liveJobStates(paths), names);
	}
}

const stateKey = (state: ReturnType<typeof readState>): string =>
	JSON.stringify([state.config, state.registry]);

/** Fetches the repository of a job, shows what changed and moves it to the new commit after consent. */
export async function updateSource(
	name: string,
	options: UpdateSourceOptions,
	deps: JobSourceDeps,
): Promise<void> {
	const paths = resolveDgPaths();
	if (existsSync(paths.daemonConfigPath)) await ensureMigrated(paths);
	const first = readState(paths);
	const found = findRecordByJob(first.registry, name);
	if (found?.record.kind !== "git") {
		throw new DgCliError(`no job named "${name}"`, EXIT_GENERAL_FAILURE);
	}
	const { source } = found;
	const record: GitSourceRecord = found.record;
	const cloneDir = jobSourceDir(paths, source);
	const run = (args: string[], cwd: string) => git(deps, [...HARDENED_GIT, ...args], cwd);
	const invalid = () =>
		stop(`the record of "${source}" in ${paths.jobSourcesPath} is not valid`);
	if (!deps.which("git")) stop("git is not installed");
	if (!existsSync(cloneDir)) {
		stop(`${cloneDir} is missing — remove the job, then add it again`);
	}
	const origin = await run(["config", "--get-all", "remote.origin.url"], cloneDir);
	const urls = origin.stdout.split("\n").filter((line) => line !== "");
	if (origin.code !== 0 || urls.length !== 1 || urls[0] !== record.url) invalid();

	const fetched = await run(
		[
			"fetch",
			"--tags",
			"--force",
			"--prune",
			"--prune-tags",
			"--no-recurse-submodules",
			"origin",
		],
		cloneDir,
	);
	if (fetched.code !== 0) {
		stop(
			`git fetch failed: ${firstLine(fetched.stderr).replaceAll(record.url, displayUrl(record.url))}`,
		);
	}
	if (record.ref === null) {
		const head = await run(["remote", "set-head", "origin", "--auto"], cloneDir);
		if (head.code !== 0) {
			stop(
				`git remote set-head failed: ${firstLine(head.stderr).replaceAll(record.url, displayUrl(record.url))}`,
			);
		}
	}
	const newSha = await findRef(deps, cloneDir, record.ref);
	if (newSha === undefined) stop(`cannot resolve "${record.ref ?? "HEAD"}" in ${source}`);
	const oldShort = record.sha.slice(0, 12);
	if (newSha === record.sha) {
		console.log(`source "${source}" is up to date at ${oldShort}`);
		return;
	}
	const newShort = (newSha as string).slice(0, 12);

	const at = { paths, source, cloneDir, url: record.url };
	const { pkg, declaration } = await readDeclared(deps, at, newSha as string, PREFIX);
	const hash = declarationHash(pkg.dg);
	const same = hash === record.declarationHash;
	const known = new Set(record.jobs);
	const names = declaration.jobs.map((job) => job.name);
	for (const job of names) {
		if (!known.has(job) && isInTable(first.config, job)) {
			stop(`a job named "${job}" already exists`);
		}
	}
	await refuseLiveJobs(paths, name, record.jobs);

	const missing = declaration.requires.filter((required) => !deps.which(required));
	if (missing.length > 0) {
		stop(`required executable(s) do not resolve on PATH: ${missing.join(", ")}`);
	}
	const resolved = resolveJobs(deps, cloneDir, declaration.jobs, PREFIX);
	const build = declaration.build && resolveBuild(deps, cloneDir, declaration.build, PREFIX, false);
	const old = same ? emptyDeclared() : await readOldBlock(deps, at, record.sha);

	console.log(`${source}: ${oldShort} -> ${newShort}`);
	if (!same) {
		console.log(
			formatRequest({
				source,
				url: record.url,
				ref: record.ref,
				sha: newSha as string,
				jobs: resolved.jobs,
				credentials: declaration.credentials,
				requires: declaration.requires,
				build,
				existingState: Object.fromEntries(
					names
						.filter((job) => !known.has(job))
						.map((job) => [job, jobStateDir(paths, job)] as const)
						.filter(([, dir]) => existsSync(dir)),
				),
			}),
		);
		for (const line of changedLines(old, declaration)) console.log(line);
	}
	if (options.yes !== true) {
		if (!deps.isTerminal()) {
			stop("consent needs a terminal — run this command in a terminal yourself, or give --yes");
		}
		const question = same ? "Update to this commit? [y/N]" : "Apply these changes? [y/N]";
		if (!(await deps.confirm(question))) {
			stop(`declined; source "${source}" stays at ${oldShort}`);
		}
	}
	const changed = () =>
		stop("the source or the daemon config changed during the question — nothing was changed");
	if (stateKey(readState(paths)) !== stateKey(first)) changed();

	let moved = false;
	let finished = false;
	const release = onInterrupt(() => {
		if (!moved || finished) return;
		try {
			Bun.spawnSync(
				["git", ...SAFE_GIT, ...HARDENED_GIT, "checkout", "--force", "--detach", record.sha, "--"],
				{ cwd: cloneDir, env: gitEnv(deps), stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
		} catch {}
	});
	const checkout = async (sha: string, force: boolean) => {
		if (!FULL_SHA.test(sha)) stop("git did not give a full commit id");
		return run(["checkout", ...(force ? ["--force"] : []), "--detach", sha, "--"], cloneDir);
	};
	const stays = `source "${source}" stays at ${oldShort} — the clone can hold build output of ${newShort}`;
	let replaced: string[] = [];
	let created: string[] = [];
	try {
		const status = await run(["status", "--porcelain", "--untracked-files=no"], cloneDir);
		if (status.code !== 0) stop(`git status failed: ${firstLine(status.stderr)}`);
		const current = (await run(["rev-parse", "HEAD"], cloneDir)).stdout.trim();
		if (status.stdout.trim() !== "" || current !== record.sha) {
			moved = true;
			const restored = await checkout(record.sha, true);
			if (restored.code !== 0) stop(`git checkout failed: ${firstLine(restored.stderr)}`);
			console.log(`discarded local changes in the clone of "${source}"`);
		}
		moved = true;
		const switched = await checkout(newSha as string, false);
		if (switched.code !== 0) stop(`git checkout failed: ${firstLine(switched.stderr)}`);

		if (declaration.build) {
			const argv = resolveBuild(deps, cloneDir, declaration.build, PREFIX);
			let code: number;
			try {
				code = await deps.runBuild(argv, cloneDir);
			} catch {
				return stop(`build did not start: ${declaration.build[0]}; ${stays}`);
			}
			if (code !== 0) stop(`build failed (exit ${code}); ${stays}`);
		}
		for (const { name: job, path } of resolved.inClone) {
			insideClone(cloneDir, path, `job "${job}": "argv" must stay inside the repository`, PREFIX);
		}

		await withConfigLock(paths, async () => {
			const state = readState(paths);
			requireMigrated(state.config);
			const stored = state.registry[source];
			if (stored?.kind !== "git" || stored.sha !== record.sha || !sameValue(stored.jobs, record.jobs)) {
				changed();
			}
			for (const job of names) {
				if (!known.has(job) && isInTable(state.config, job)) {
					stop(`a job named "${job}" already exists`);
				}
			}
			const removed = record.jobs.filter((job) => !names.includes(job));
			for (const job of removed) assertNoLiveInstance(paths, job, "job");
			if (removed.length > 0) await refuseLiveJobs(paths, name, removed);
			const next: GitSourceRecord = same
				? { ...record, sha: newSha as string }
				: {
						...record,
						sha: newSha as string,
						declarationHash: hash,
						jobs: names,
						credentials: declaration.credentials,
					};
			const restores = [snapshotOf(paths.daemonConfigPath), snapshotOf(paths.jobSourcesPath)];
			try {
				guardConfig(() => {
					if (!same) {
						({ replaced, created } = writeBlockEntries(paths, state.config, resolved.jobs));
						for (const job of removed) {
							if (isInTable(state.config, job)) writeJobEntry(paths, job, undefined);
						}
					}
					writeSource(paths, source, next);
					finished = true;
				});
			} catch (err) {
				rollBack(err, restores, paths, source);
			}
		});
	} catch (err) {
		if (moved && !finished) {
			const back = await run(
				["checkout", "--force", "--detach", record.sha, "--"],
				cloneDir,
			).catch((failure: unknown) => ({
				code: 1,
				stdout: "",
				stderr: describeError(failure),
			}));
			const where =
				back.code === 0
					? `the clone ${cloneDir} is at ${oldShort}`
					: `git checkout of the old commit failed: ${firstLine(back.stderr)} — the clone ${cloneDir} is not at ${oldShort}`;
			if (back.code !== 0 || err instanceof RollbackFailure) {
				throw new DgCliError(`${describeError(err)}; ${where}`, EXIT_GENERAL_FAILURE);
			}
		}
		throw err;
	} finally {
		release();
	}

	console.log(`updated source "${source}" ${oldShort} -> ${newShort}`);
	for (const line of replaced) console.log(line);
	for (const job of created) console.log(`next: dg job enable ${job}`);
	if (!same) {
		const before = new Set(credentialMap(old).keys());
		const setup = new Set<string>();
		for (const credential of describeCredentials(declaration.jobs, declaration.credentials)) {
			if (before.has(credential.name)) continue;
			for (const job of credential.jobs) setup.add(job);
		}
		for (const job of setup) console.log(`next: dg job setup ${job}`);
	}
}
