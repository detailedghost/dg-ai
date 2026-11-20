import { createHash } from "node:crypto";
import { isAbsolute, resolve, win32 } from "node:path";
import { describeError, isRecord } from "@dg/common";
import { insideRoot, isJobName } from "@dg/common/node";
import { envNameProblem, JOB_NAME_RULE, parseJobEntry } from "./config";

export type DeclaredJob = { name: string; entry: Record<string, unknown> };

export type DeclaredCredential = {
	name: string;
	required: boolean;
	prompt: string;
	env?: string;
	source?: Record<string, string>;
	meta: Record<string, { prompt: string; default?: string }>;
	jobs: string[];
};

export type Declaration =
	| {
			ok: true;
			jobs: DeclaredJob[];
			credentials: Record<string, unknown>;
			requires: string[];
			build: string[] | undefined;
	  }
	| { ok: false; error: string };

export type DeclarationContext = {
	source: string;
	sourceDir: string;
	stateDir: (name: string) => string;
};

const DG_KEYS = ["jobs", "credentials", "requires", "build"];
const FORBIDDEN_JOB_KEYS = ["grant", "cwd", "enabled", "passEnv", "credentialEnv"];
const DETAIL_KEYS = ["prompt", "required", "meta", "source", "env"];
const SOURCE_TYPE = "aws-secretsmanager";
const SOURCE_KEYS = ["type", "secretId", "region", "key", "profile"];
const SECRET_LIKE_KEY = /value|secret|token|password/i;
const STORE_OWNED_META = ["provider", "createdBy"];
const STRUCTURED_META = ["scopes", "expiresAt"];
const REGION = /^[a-z0-9-]+$/;
const MAX_JOBS = 16;
const MAX_ARGV = 64;
const MAX_STRING = 1024;
const MAX_PROMPT = 200;
const MAX_CREDENTIALS = 16;

class Refusal extends Error {}

const refuse = (message: string): never => {
	throw new Refusal(message);
};

const unknownKeys = (value: Record<string, unknown>, allowed: string[]) =>
	Object.keys(value).filter((key) => !allowed.includes(key));

function checkStrings(value: unknown): void {
	if (typeof value === "string") {
		if (value.length > MAX_STRING) {
			refuse(`a string in the "dg" block is longer than ${MAX_STRING} characters`);
		}
	} else if (Array.isArray(value)) {
		value.forEach(checkStrings);
	} else if (isRecord(value)) {
		Object.values(value).forEach(checkStrings);
	}
}

const isRelativeSafe = (path: string) =>
	path.length > 0 && !isAbsolute(path) && !win32.isAbsolute(path);

function declaredJob(name: string, raw: unknown, context: DeclarationContext): DeclaredJob {
	const fail = (message: string) => refuse(`job "${name}": ${message}`);
	if (!isJobName(name)) fail(`name ${JOB_NAME_RULE}`);
	if (!isRecord(raw)) fail("must be an object");
	const job = raw as Record<string, unknown>;
	for (const key of FORBIDDEN_JOB_KEYS) {
		if (Object.hasOwn(job, key)) fail(`the key "${key}" is set by dg`);
	}
	if (Array.isArray(job.argv) && job.argv.length > MAX_ARGV) {
		fail(`"argv" can hold ${MAX_ARGV} items at most`);
	}
	if (job.credentials !== undefined && !Array.isArray(job.credentials)) {
		fail('"credentials" must be an array of credential names');
	}
	const entry: Record<string, unknown> = { ...job, cwd: context.sourceDir };
	if (job.envFile !== undefined) {
		const stateDir = context.stateDir(name);
		const file =
			typeof job.envFile === "string" && isRelativeSafe(job.envFile)
				? resolve(stateDir, job.envFile)
				: undefined;
		if (file === undefined || !insideRoot(stateDir, file)) {
			fail('"envFile" must be a relative path inside the state folder of the job');
		} else {
			entry.envFile = file;
		}
	}
	const first = Array.isArray(job.argv) ? job.argv[0] : undefined;
	if (typeof first === "string" && first.includes("/")) {
		if (!insideRoot(context.sourceDir, resolve(context.sourceDir, first))) {
			fail('"argv" must stay inside the repository');
		}
	}
	const credentials = Array.isArray(job.credentials) ? job.credentials : [];
	if (credentials.length === 0) delete entry.credentials;
	else entry.grant = context.source;
	const parsed = parseJobEntry(name, entry);
	if (!parsed.ok) return fail(parsed.error);
	if (credentials.length > 0) entry.credentials = parsed.credentials;
	return { name, entry };
}

function checkSource(name: string, source: unknown): void {
	const fail = (message: string) => refuse(`credential "${name}": ${message}`);
	if (!isRecord(source)) fail('"source" must be an object');
	const record = source as Record<string, unknown>;
	if (record.type !== SOURCE_TYPE) {
		fail(
			`unknown source type ${typeof record.type === "string" ? `"${record.type}"` : "(missing)"}`,
		);
	}
	const [stray] = unknownKeys(record, SOURCE_KEYS);
	if (stray !== undefined) fail(`unknown key "${stray}" in "source"`);
	const valid = (value: unknown) =>
		typeof value === "string" && value.length > 0 && !value.startsWith("-");
	for (const key of ["secretId", "region"]) {
		if (!valid(record[key])) fail(`"${key}" is not valid`);
	}
	if (!REGION.test(record.region as string)) fail('"region" is not valid');
	for (const key of ["key", "profile"]) {
		if (record[key] !== undefined && !valid(record[key])) fail(`"${key}" is not valid`);
	}
}

function checkMeta(name: string, meta: unknown): void {
	const fail = (message: string) => refuse(`credential "${name}": ${message}`);
	if (!isRecord(meta)) fail('"meta" must be an object');
	for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
		if (SECRET_LIKE_KEY.test(key)) fail(`the meta key "${key}" looks like a secret`);
		if (STORE_OWNED_META.includes(key)) fail(`the meta key "${key}" is set by dg`);
		if (STRUCTURED_META.includes(key)) fail(`the meta key "${key}" cannot be given as text`);
		if (!isRecord(value) || unknownKeys(value, ["prompt", "default"]).length > 0) {
			fail(`the meta key "${key}" must be an object with "prompt" and "default"`);
		}
		const { prompt, default: fallback } = value as Record<string, unknown>;
		if (typeof prompt !== "string" || prompt.length > MAX_PROMPT) {
			fail(`the meta key "${key}" needs a "prompt" of ${MAX_PROMPT} characters at most`);
		}
		if (fallback !== undefined && (typeof fallback !== "string" || fallback.length > MAX_PROMPT)) {
			fail(`the meta key "${key}" needs a "default" of ${MAX_PROMPT} characters at most`);
		}
	}
}

function checkDetails(name: string, details: unknown): void {
	const fail = (message: string) => refuse(`credential "${name}": ${message}`);
	if (!isRecord(details)) fail("must be an object");
	const record = details as Record<string, unknown>;
	const stray = unknownKeys(record, DETAIL_KEYS);
	if (stray.length > 0) fail(`unknown key(s): ${stray.join(", ")}`);
	if (
		record.prompt !== undefined &&
		(typeof record.prompt !== "string" || record.prompt.length > MAX_PROMPT)
	) {
		fail(`"prompt" must be a string of ${MAX_PROMPT} characters at most`);
	}
	if (record.required !== undefined && typeof record.required !== "boolean") {
		fail('"required" must be a boolean');
	}
	if (record.env !== undefined) {
		if (typeof record.env !== "string") fail('"env" must be a variable name');
		const problem = envNameProblem(record.env as string);
		if (problem) fail(`"env": ${problem}`);
		if (record.required === false) {
			fail('"env" needs a required credential — a bound credential is required at launch');
		}
	}
	if (record.meta !== undefined) checkMeta(name, record.meta);
	if (record.source !== undefined) checkSource(name, record.source);
}

function checkCredentials(jobs: DeclaredJob[], details: unknown): Record<string, unknown> {
	if (details !== undefined && !isRecord(details)) refuse('"credentials" must be an object');
	const listed = new Set(
		jobs.flatMap(({ entry }) => (entry.credentials as string[] | undefined) ?? []),
	);
	if (listed.size > MAX_CREDENTIALS) {
		refuse(`a "dg" block can declare ${MAX_CREDENTIALS} credentials at most`);
	}
	const given = (details ?? {}) as Record<string, unknown>;
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(given)) {
		const folded = name.toLowerCase();
		if (seen.has(folded)) {
			refuse(`credential "${folded}" is declared two times in "credentials" (names ignore letter case)`);
		}
		seen.add(folded);
		if (!listed.has(name.toLowerCase())) {
			refuse(`credential "${name}" is not in the "credentials" list of a job`);
		}
		checkDetails(name, value);
	}
	return given;
}

function bindEnv(jobs: DeclaredJob[], details: Record<string, unknown>): void {
	const variables = new Map<string, string>();
	for (const [name, value] of Object.entries(details)) {
		const env = (value as Record<string, unknown>).env;
		if (typeof env === "string") variables.set(name.toLowerCase(), env);
	}
	if (variables.size === 0) return;
	for (const { name, entry } of jobs) {
		const bound = new Map<string, string>();
		for (const credential of (entry.credentials as string[] | undefined) ?? []) {
			const variable = variables.get(credential);
			if (variable === undefined) continue;
			if (bound.has(variable)) {
				refuse(`job "${name}": environment variable ${JSON.stringify(variable)} is bound to two credentials`);
			}
			bound.set(variable, credential);
		}
		if (bound.size === 0) continue;
		entry.credentialEnv = Object.fromEntries(bound);
		const parsed = parseJobEntry(name, entry);
		if (!parsed.ok) refuse(`job "${name}": ${parsed.error}`);
	}
}

function stringList(value: unknown, message: string, bare: boolean): string[] {
	const ok =
		Array.isArray(value) &&
		value.every(
			(item) =>
				typeof item === "string" &&
				item.length > 0 &&
				!(bare && (item.includes("/") || item.includes("\\"))),
		);
	return ok ? (value as string[]) : refuse(message);
}

function readDeclaration(packageJson: unknown, context: DeclarationContext): Declaration {
	if (!isRecord(packageJson) || !Object.hasOwn(packageJson, "dg")) {
		return { ok: false, error: 'no "dg" key in package.json' };
	}
	const dg = packageJson.dg;
	if (!isRecord(dg)) return { ok: false, error: '"dg" must be an object' };
	const stray = unknownKeys(dg, DG_KEYS);
	if (stray.length > 0) return { ok: false, error: `unknown key(s): ${stray.join(", ")}` };
	checkStrings(dg);
	if (dg.jobs !== undefined && !isRecord(dg.jobs)) {
		refuse('"jobs" must be an object keyed by job name');
	}
	const rawJobs = Object.entries((dg.jobs ?? {}) as Record<string, unknown>);
	if (rawJobs.length > MAX_JOBS) refuse(`a "dg" block can declare ${MAX_JOBS} jobs at most`);
	const jobs = rawJobs.map(([name, raw]) => declaredJob(name, raw, context));
	const credentials = checkCredentials(jobs, dg.credentials);
	bindEnv(jobs, credentials);
	const requires =
		dg.requires === undefined
			? []
			: stringList(dg.requires, '"requires" must be an array of executable names', true);
	const buildRule = '"build" must be a non-empty array of non-empty strings';
	const build =
		dg.build === undefined ? undefined : stringList(dg.build, buildRule, false);
	if (build?.length === 0) refuse(buildRule);
	return { ok: true, jobs, credentials, requires, build };
}

export function parseJobDeclaration(
	packageJson: unknown,
	context: DeclarationContext,
): Declaration {
	try {
		return readDeclaration(packageJson, context);
	} catch (err) {
		return { ok: false, error: err instanceof Refusal ? err.message : describeError(err) };
	}
}

export function describeCredentials(
	jobs: DeclaredJob[],
	details: Record<string, unknown>,
): DeclaredCredential[] {
	const byName = new Map(Object.entries(details).map(([name, value]) => [name.toLowerCase(), value]));
	const listing = new Map<string, string[]>();
	for (const { name: job, entry } of jobs) {
		for (const name of (entry.credentials as string[] | undefined) ?? []) {
			listing.set(name, [...(listing.get(name) ?? []), job]);
		}
	}
	return [...listing].map(([name, owners]) => {
		const detail = (byName.get(name) ?? {}) as Record<string, unknown>;
		return {
			name,
			required: detail.required !== false,
			prompt: typeof detail.prompt === "string" ? detail.prompt : name,
			...(typeof detail.env === "string" ? { env: detail.env } : {}),
			...(detail.source === undefined ? {} : { source: detail.source as Record<string, string> }),
			meta: (detail.meta ?? {}) as DeclaredCredential["meta"],
			jobs: owners,
		};
	});
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) {
		const body = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
		return `{${body.join(",")}}`;
	}
	return JSON.stringify(value);
}

export const declarationHash = (dg: unknown): string =>
	createHash("sha256").update(canonical(dg)).digest("hex");
