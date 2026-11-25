import { closeSync, constants, existsSync, openSync, readSync } from "node:fs";
import {
	CHAT_JOBS_PATH,
	type CredentialMeta,
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	isRecord,
	noteSecret,
	validateCredentialMeta,
	validateCredentialValue,
} from "@dg/common";
import {
	createJobCredentialClient,
	type DgPaths,
	type JobCredentialClient,
	type JobCredentialStatus,
	promptHidden,
	readLine,
} from "@dg/common/node";
import { JOBS_CONFIG_KEY, parseJobEntry } from "../jobs/config";
import {
	type DeclaredCredential,
	describeCredentials,
} from "../jobs/declaration";
import { sanitize } from "../jobs/sanitize";
import {
	defaultRunSource,
	fetchSecret,
	type RunSource,
	SecretFetchError,
	type SecretSource,
} from "../jobs/secret-sources";
import {
	type AnswerContext,
	checkAnswers,
	parseSetupAnswers,
	type SetupAnswer,
} from "../jobs/setup-answers";
import {
	findMarkRecord,
	readSourceRecords,
	updateMarks,
} from "../jobs/sources";
import { readConfigStrict, writeJobEntry } from "../server/config-store";
import { assertPrivateOpenFile } from "../services/env-file";
import type { ServiceStatus } from "../services/supervisor";
import { rollBack, snapshotOf } from "./job-source";
import {
	assertDaemonAnswers,
	callDaemon,
	defaultJobVerbDeps,
	ensureMigrated,
	findLiveDaemon,
	guardConfig,
	isInTable,
	type JobVerbDeps,
	requireMigrated,
	withConfigLock,
} from "./job-support";
import { startDaemon } from "./start";

export type JobSetupDeps = JobVerbDeps & {
	readHidden(prompt: string): Promise<string>;
	readLine(prompt: string): Promise<string | null>;
	runSource: RunSource;
	client(paths: DgPaths, job: string): JobCredentialClient;
	stdin(): ReadableStream<Uint8Array>;
};

type Verb = "enable" | "setup";
type State = "stored" | "expired" | "missing";

type Item = {
	name: string;
	full: string;
	detail: DeclaredCredential;
	source: SecretSource | undefined;
	state: State;
	updatedAt?: string;
	expiresAt?: string;
	meta: CredentialMeta;
};

type Loaded = {
	name: string;
	prefix: string;
	credentials: string[];
	details: DeclaredCredential[];
	recordKey: string;
	accepted: boolean;
	done: boolean;
};

type Ctx = {
	deps: JobSetupDeps;
	verb: Verb;
	paths: DgPaths;
	job: Loaded;
	client: JobCredentialClient;
	status: JobCredentialStatus;
	items: Item[];
};

type Pending = { name: string; full: string; value: string; meta: CredentialMeta };

const CREATED_BY = "dg job setup";
const SETUP_LIMIT_KIB = 128;
const SETUP_LIMIT_BYTES = SETUP_LIMIT_KIB * 1024;
const ADOPTION_QUESTION = "This job can read these credentials. Continue? [y/N]";
const SERVICE_LABEL = "AWS Secrets Manager";

const fail = (message: string): never => {
	throw new DgCliError(message, EXIT_GENERAL_FAILURE);
};

class FetchFailure extends DgCliError {}

const questionConfirm = async (question: string): Promise<boolean> => {
	const line = await readLine(`${question} `);
	if (line === null) return false;
	const answer = line.trim().toLowerCase();
	return answer === "" ? !question.endsWith("[y/N]") : answer.startsWith("y");
};

export const defaultJobSetupDeps = (): JobSetupDeps => ({
	...defaultJobVerbDeps(),
	confirm: questionConfirm,
	readHidden: (prompt) => promptHidden(prompt),
	readLine,
	runSource: defaultRunSource,
	client: (paths, job) => createJobCredentialClient({ paths, job }),
	stdin: () => Bun.stdin.stream(),
});

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.length;
		if (total > SETUP_LIMIT_BYTES) fail(`--setup input is larger than ${SETUP_LIMIT_KIB} KiB`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function readFileLimited(path: string): string {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
	} catch {
		return fail(`--setup: cannot read ${sanitize(path)}`);
	}
	try {
		assertPrivateOpenFile(fd, sanitize(path), "--setup file");
		const buffer = Buffer.alloc(SETUP_LIMIT_BYTES + 1);
		let length = 0;
		for (;;) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
			if (length > SETUP_LIMIT_BYTES) fail(`--setup input is larger than ${SETUP_LIMIT_KIB} KiB`);
		}
		return buffer.subarray(0, length).toString("utf8");
	} catch (err) {
		if (err instanceof DgCliError) throw err;
		return fail(describeError(err));
	} finally {
		closeSync(fd);
	}
}

async function readSetupText(spec: string, deps: JobSetupDeps): Promise<string> {
	return spec === "-" ? readStream(deps.stdin()) : readFileLimited(spec);
}

function readEntry(paths: DgPaths, name: string): Record<string, unknown> | undefined {
	if (!existsSync(paths.daemonConfigPath)) return undefined;
	const config = guardConfig(() => readConfigStrict(paths));
	if (!isInTable(config, name)) return undefined;
	const entry = (config[JOBS_CONFIG_KEY] as Record<string, unknown>)[name];
	return isRecord(entry) ? entry : undefined;
}

function refuseNoCredential(paths: DgPaths, name: string): void {
	const entry = readEntry(paths, name);
	if (entry && !(Array.isArray(entry.credentials) && entry.credentials.length > 0)) {
		fail(`job setup: job "${name}" lists no credential`);
	}
}

function loadJob(paths: DgPaths, name: string, verb: Verb): Loaded {
	const config = guardConfig(() => readConfigStrict(paths));
	requireMigrated(config);
	const entry = readEntry(paths, name);
	if (!entry) return fail(`no job named "${name}"`);
	const parsed = parseJobEntry(name, entry);
	if (!parsed.ok) return fail(`job ${verb}: job "${name}" is not valid: ${parsed.error}`);
	if (parsed.credentials.length === 0) fail(`job ${verb}: job "${name}" lists no credential`);
	if (parsed.grant === undefined) fail(`job ${verb}: job "${name}" has no credential prefix`);
	const found = findMarkRecord(guardConfig(() => readSourceRecords(paths)), name);
	const stored = found && "credentials" in found.record ? found.record.credentials : {};
	return {
		name,
		prefix: parsed.grant as string,
		credentials: parsed.credentials,
		details: describeCredentials([{ name, entry: { ...entry, credentials: parsed.credentials } }], stored),
		recordKey: found?.source ?? name,
		accepted: found?.record.prefixAccepted === true,
		done: found?.record.setupDone?.includes(name) === true,
	};
}

function toSource(raw: Record<string, string> | undefined): SecretSource | undefined {
	if (!raw || raw.type !== "aws-secretsmanager") return undefined;
	if (typeof raw.secretId !== "string" || typeof raw.region !== "string") return undefined;
	return {
		type: "aws-secretsmanager",
		secretId: raw.secretId,
		region: raw.region,
		...(raw.key === undefined ? {} : { key: raw.key }),
		...(raw.profile === undefined ? {} : { profile: raw.profile }),
	};
}

function itemsOf(job: Loaded, status: JobCredentialStatus): Item[] {
	return job.details.map((detail) => {
		const full = `${job.prefix}/${detail.name}`.toLowerCase();
		const held = status.credentials.find((entry) => entry.name.toLowerCase() === full);
		const expiresAt = typeof held?.meta.expiresAt === "string" ? held.meta.expiresAt : undefined;
		const expired = expiresAt !== undefined && Date.parse(expiresAt) < Date.now();
		return {
			name: detail.name,
			full,
			detail,
			source: toSource(detail.source),
			state: held === undefined ? "missing" : expired ? "expired" : "stored",
			updatedAt: held?.updatedAt,
			expiresAt,
			meta: held?.meta ?? {},
		};
	});
}

async function ensureDaemon(paths: DgPaths, deps: JobSetupDeps): Promise<void> {
	if (await findLiveDaemon(paths)) return;
	try {
		await startDaemon(paths, { autostart: deps.autostart });
	} catch (err) {
		if (err instanceof DgCliError) throw err;
		fail(describeError(err));
	}
}

async function open(
	paths: DgPaths,
	name: string,
	verb: Verb,
	deps: JobSetupDeps,
): Promise<{ job: Loaded; client: JobCredentialClient }> {
	await assertDaemonAnswers(paths, name);
	if (existsSync(paths.daemonConfigPath)) await ensureMigrated(paths);
	const job = loadJob(paths, name, verb);
	return { job, client: deps.client(paths, name) };
}

async function load(
	paths: DgPaths,
	job: Loaded,
	client: JobCredentialClient,
	verb: Verb,
	deps: JobSetupDeps,
): Promise<Ctx> {
	await ensureDaemon(paths, deps);
	const status = await client.status();
	return { deps, verb, paths, job, client, status, items: itemsOf(job, status) };
}

async function adopt(ctx: Ctx): Promise<void> {
	const { status, job, verb, deps } = ctx;
	if (job.accepted) return;
	if (status.grant === "missing" && status.credentials.length === 0) return;
	if (!deps.isTerminal()) {
		fail(`job ${verb}: the prefix ${job.prefix}/ holds credentials — run this command in a terminal one time`);
	}
	console.error(
		`credentials below ${sanitize(job.prefix)}/: ${
			status.credentials.map((entry) => sanitize(entry.name)).join(", ") || "none"
		}`,
	);
	if (!(await deps.confirm(ADOPTION_QUESTION))) fail(`job ${verb}: declined; nothing was stored`);
	await withConfigLock(ctx.paths, () =>
		guardConfig(() => updateMarks(ctx.paths, job.name, { prefixAccepted: true })),
	);
}

function failureOf(err: SecretFetchError, item: Item, source: SecretSource): string {
	const name = sanitize(item.name);
	switch (err.kind) {
		case "not-installed":
			return `job setup: aws is not installed — it is necessary for ${name}`;
		case "no-text":
			return `job setup: the secret of ${name} has no text value`;
		case "invalid-json":
			return `job setup: the secret of ${name} is not JSON`;
		case "no-key":
			return `job setup: the secret has no key "${sanitize(source.key ?? "")}"`;
		default: {
			const profile = source.profile === undefined ? "" : ` --profile ${sanitize(source.profile)}`;
			return `job setup: aws failed for ${name}: ${err.message}\nhint: aws sso login${profile}`;
		}
	}
}

async function fetchFor(
	ctx: Ctx,
	item: Item,
	source: SecretSource,
	profile?: string,
): Promise<string> {
	const effective = profile === undefined ? source : { ...source, profile };
	console.error(`fetching ${sanitize(item.name)} from ${SERVICE_LABEL}`);
	try {
		return await fetchSecret(effective, {
			which: ctx.deps.which,
			runSource: ctx.deps.runSource,
			env: process.env,
		});
	} catch (err) {
		if (!(err instanceof SecretFetchError)) throw err;
		throw new FetchFailure(failureOf(err, item, effective), EXIT_GENERAL_FAILURE);
	}
}

function pending(
	item: Item,
	value: string,
	meta: CredentialMeta,
	extra: { expiresAt?: string; provider?: string } = {},
): Pending {
	noteSecret(value);
	const all: CredentialMeta = {
		...meta,
		...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
		createdBy: CREATED_BY,
		...(extra.provider === undefined ? {} : { provider: extra.provider }),
	};
	try {
		validateCredentialValue(value);
		validateCredentialMeta(all);
	} catch (err) {
		fail(`job setup: ${sanitize(item.name)}: ${describeError(err)}`);
	}
	return { name: item.name, full: item.full, value, meta: all };
}

async function askMeta(
	ctx: Ctx,
	item: Item,
	given?: Record<string, string>,
): Promise<Record<string, string>> {
	const meta: Record<string, string> = { ...given };
	for (const [key, entry] of Object.entries(item.detail.meta)) {
		if (Object.hasOwn(meta, key)) continue;
		let answer = "";
		if (given === undefined && ctx.deps.isTerminal()) {
			const shown = entry.default === undefined ? "" : ` [${sanitize(entry.default)}]`;
			answer = ((await ctx.deps.readLine(`${sanitize(entry.prompt)}${shown}: `)) ?? "").trim();
		}
		const text = answer === "" ? entry.default : answer;
		if (text !== undefined) meta[key] = text;
	}
	return meta;
}

async function promptValue(ctx: Ctx, item: Item): Promise<string | undefined> {
	for (;;) {
		const value = await ctx.deps.readHidden(`${sanitize(item.detail.prompt)}: `);
		if (value !== "") return value;
		if (!item.detail.required) return undefined;
		console.error(`${sanitize(item.name)} is required`);
	}
}

async function obtain(ctx: Ctx, item: Item): Promise<Pending | undefined> {
	if (item.source !== undefined) {
		let value: string | undefined;
		try {
			value = await fetchFor(ctx, item, item.source);
		} catch (err) {
			if (!(err instanceof FetchFailure) || !ctx.deps.isTerminal()) throw err;
			console.error(err.message);
			if (!(await ctx.deps.confirm(`Enter ${sanitize(item.name)} by hand? [y/N]`))) {
				return fail("job setup: stopped; nothing was stored");
			}
		}
		if (value !== undefined) {
			return pending(item, value, await askMeta(ctx, item), {
				provider: item.source.type,
			});
		}
	}
	const typed = await promptValue(ctx, item);
	return typed === undefined ? undefined : pending(item, typed, await askMeta(ctx, item));
}

async function fromAnswer(ctx: Ctx, item: Item, answer: SetupAnswer): Promise<Pending | undefined> {
	if (answer.kind === "keep" || answer.kind === "skip") return undefined;
	const meta = await askMeta(ctx, item, answer.meta ?? {});
	if (answer.kind === "value") {
		return pending(item, answer.value, meta, { expiresAt: answer.expiresAt });
	}
	const source = item.source as SecretSource;
	const value = await fetchFor(ctx, item, source, answer.profile);
	return pending(item, value, meta, { expiresAt: answer.expiresAt, provider: source.type });
}

const wantsValue = (ctx: Ctx, item: Item): boolean =>
	item.detail.required ? item.state !== "stored" : item.state === "missing" && !ctx.job.done;

async function collectEnable(
	ctx: Ctx,
	answers: Record<string, SetupAnswer>,
): Promise<Pending[]> {
	const answered = (item: Item) => Object.hasOwn(answers, item.name);
	const blocked = ctx.items.filter(
		(item) =>
			!answered(item) &&
			item.detail.required &&
			item.state !== "stored" &&
			item.source === undefined,
	);
	if (blocked.length > 0 && !ctx.deps.isTerminal()) {
		fail(
			`job enable: credentials missing or expired: ${blocked.map((item) => sanitize(item.name)).join(", ")} — run dg job setup ${ctx.job.name} in a terminal, or give --setup`,
		);
	}
	const out: Pending[] = [];
	for (const item of ctx.items) {
		let found: Pending | undefined;
		if (answered(item)) found = await fromAnswer(ctx, item, answers[item.name]);
		else if (wantsValue(ctx, item) && (item.source !== undefined || ctx.deps.isTerminal())) {
			found = await obtain(ctx, item);
		}
		if (found) out.push(found);
	}
	return out;
}

async function collectSetup(ctx: Ctx): Promise<Pending[]> {
	const out: Pending[] = [];
	for (const item of ctx.items) {
		const name = sanitize(item.name);
		if (item.state === "missing") console.error(`${name}: missing`);
		else if (item.state === "expired") {
			console.error(`${name}: expired ${item.expiresAt?.slice(0, 10) ?? ""}`.trimEnd());
		} else console.error(`${name}: stored, updated ${item.updatedAt?.slice(0, 10) ?? "unknown"}`);
		if (item.state !== "missing" && !(await ctx.deps.confirm(`Replace ${name}? [y/N]`))) continue;
		const found = await obtain(ctx, item);
		if (found) out.push(found);
	}
	return out;
}

async function acceptFirstStore(ctx: Ctx, stored: string[]): Promise<void> {
	if (stored.length === 0 || ctx.status.credentials.length > 0) return;
	await withConfigLock(ctx.paths, () =>
		guardConfig(() => updateMarks(ctx.paths, ctx.job.name, { prefixAccepted: true })),
	);
}

async function store(ctx: Ctx, items: Pending[], options: { grant: boolean }): Promise<string[]> {
	const stored: string[] = [];
	const stop = async (what: string, err: unknown): Promise<never> => {
		try {
			await acceptFirstStore(ctx, stored);
		} catch (markErr) {
			console.error(`warning: could not record the prefix: ${describeError(markErr)}`);
		}
		if (stored.length > 0) console.error(`stored: ${stored.join(", ")}`);
		return fail(`job ${ctx.verb}: ${what}: ${describeError(err)}`);
	};
	for (const item of items) {
		try {
			await ctx.client.set(item.full, item.value, item.meta);
		} catch (err) {
			await stop(`could not store ${sanitize(item.name)}`, err);
		}
		stored.push(sanitize(item.name));
	}
	if (options.grant) {
		try {
			await ctx.client.ensureGrant();
		} catch (err) {
			await stop("could not make the token", err);
		}
	}
	return stored;
}

async function commit(ctx: Ctx, stored: string[], enable: boolean): Promise<void> {
	const { paths, job } = ctx;
	await withConfigLock(paths, () => {
		const config = guardConfig(() => readConfigStrict(paths));
		requireMigrated(config);
		const entry = readEntry(paths, job.name);
		const parsed = entry && parseJobEntry(job.name, entry);
		if (
			!entry ||
			!parsed?.ok ||
			JSON.stringify(parsed.credentials) !== JSON.stringify(job.credentials)
		) {
			fail(`job ${ctx.verb}: job "${job.name}" changed while it was set up — run the command again`);
		}
		const restores = [snapshotOf(paths.daemonConfigPath), snapshotOf(paths.jobSourcesPath)];
		try {
			guardConfig(() => {
				updateMarks(paths, job.name, {
					...(stored.length > 0 && ctx.status.credentials.length === 0
						? { prefixAccepted: true as const }
						: {}),
					setupDone: job.name,
				});
				if (enable && entry?.enabled !== true) {
					writeJobEntry(paths, job.name, { ...entry, enabled: true });
				}
			});
		} catch (err) {
			rollBack(err, restores, paths, job.recordKey, "");
		}
	});
}

async function nextLines(ctx: Ctx): Promise<void> {
	try {
		const config = guardConfig(() => readConfigStrict(ctx.paths));
		const table = isRecord(config[JOBS_CONFIG_KEY]) ? (config[JOBS_CONFIG_KEY] as Record<string, unknown>) : {};
		const sharing = Object.entries(table)
			.filter(
				([, entry]) =>
					isRecord(entry) &&
					typeof entry.grant === "string" &&
					entry.grant.toLowerCase() === ctx.job.prefix.toLowerCase(),
			)
			.map(([name]) => name);
		const body = (await callDaemon(CHAT_JOBS_PATH, "GET")) as { jobs: ServiceStatus[] };
		const running = body.jobs
			.filter((row) => sharing.includes(row.label) && (row.state === "running" || row.state === "backoff"))
			.map((row) => row.label)
			.sort();
		for (const name of running) console.log(`next: dg job restart ${name}`);
	} catch (err) {
		console.error(`warning: could not read the job states: ${describeError(err)}`);
	}
}

/** The wizard of `job enable` for a job that lists credentials; it leaves the login question and the start to the caller. */
export async function runEnableWizard(
	paths: DgPaths,
	name: string,
	options: { setup?: string },
	deps: JobSetupDeps,
): Promise<void> {
	const text = options.setup === undefined ? undefined : await readSetupText(options.setup, deps);
	const { job, client } = await open(paths, name, "enable", deps);
	let answers: Record<string, SetupAnswer> = Object.create(null);
	if (text !== undefined) {
		const parsed = parseSetupAnswers(text, { job: name, credentials: job.credentials });
		if (!parsed.ok) fail(parsed.error);
		else answers = parsed.answers;
	}
	const ctx = await load(paths, job, client, "enable", deps);
	const contexts: AnswerContext[] = ctx.items.map((item) => ({
		name: item.name,
		required: item.detail.required,
		hasSource: item.source !== undefined,
		state: item.state,
	}));
	const wrong = checkAnswers(answers, contexts);
	if (wrong !== undefined) fail(wrong);
	await adopt(ctx);
	const pendings = await collectEnable(ctx, answers);
	const stored = await store(ctx, pendings, { grant: true });
	await commit(ctx, stored, true);
	if (stored.length > 0) console.log(`stored ${stored.join(", ")}`);
}

async function rotate(ctx: Ctx): Promise<void> {
	await ctx.client.rotateGrant();
	console.log(`rotated the token of the prefix ${ctx.job.prefix}/`);
	await nextLines(ctx);
}

async function refresh(ctx: Ctx): Promise<void> {
	const fetched = ctx.items.filter((item) => item.source !== undefined);
	if (fetched.length === 0) {
		fail(
			`job setup: no credential of job "${ctx.job.name}" has a source — run dg job setup ${ctx.job.name} to enter a value`,
		);
	}
	const items: Pending[] = [];
	for (const item of fetched) {
		const source = item.source as SecretSource;
		const value = await fetchFor(ctx, item, source);
		const kept = Object.fromEntries(
			Object.entries(item.meta).filter(([key]) => key !== "expiresAt"),
		);
		items.push(pending(item, value, kept, { provider: source.type }));
	}
	const stored = await store(ctx, items, { grant: false });
	await acceptFirstStore(ctx, stored);
	console.log(`refreshed ${stored.join(", ")}`);
	await nextLines(ctx);
}

/** The `job setup` verb: ask for the credentials, fetch them again, or rotate the token. */
export async function runSetup(
	paths: DgPaths,
	name: string,
	options: { refresh?: boolean; rotateToken?: boolean },
	deps: JobSetupDeps,
): Promise<void> {
	if (options.refresh && options.rotateToken) fail("job setup: give --refresh alone");
	const asks = !options.refresh && !options.rotateToken;
	if (asks && !deps.isTerminal()) {
		fail("job setup: this command asks questions — run it in a terminal, or use dg job enable --setup <file>");
	}
	refuseNoCredential(paths, name);
	const { job, client } = await open(paths, name, "setup", deps);
	const ctx = await load(paths, job, client, "setup", deps);
	await adopt(ctx);
	if (options.rotateToken) {
		if (ctx.status.grant === "missing") {
			fail(`job setup: job "${name}" has no token to rotate — run dg job enable ${name}`);
		}
		return rotate(ctx);
	}
	if (options.refresh) return refresh(ctx);
	const pendings = await collectSetup(ctx);
	const stored = await store(ctx, pendings, { grant: pendings.length > 0 });
	if (stored.length > 0 || ctx.items.some((item) => item.state === "missing")) {
		await commit(ctx, stored, false);
	}
	if (stored.length === 0) return;
	console.log(`stored ${stored.join(", ")}`);
	await nextLines(ctx);
}
