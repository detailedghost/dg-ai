import { delimiter, isAbsolute } from "node:path";
import { isRecord, noteSecret, validateCredentialName, validateCredentialValue } from "@dg/common";
import { type DgPaths, ensurePrivateDir, jobStateDir } from "@dg/common/node";
import type { Logger } from "../server/log";
import type { CredentialStore } from "../store/credentials-store";
import type { JobDecl } from "./config";
import { buildBaseEnv } from "./launcher";
import { sanitize } from "./sanitize";
import {
	fetchSecret,
	type RunSource,
	SecretFetchError,
	type SecretSource,
} from "./secret-sources";
import { findRecordByJob, readSourceRecords } from "./sources";

export const REFRESH_WINDOW_MS = 60_000;
const MAX_LINE = 200;

export type RefreshLimiter = {
	claim(name: string, now: number): number | undefined;
	release(name: string): void;
	size(): number;
};

export function createRefreshLimiter(): RefreshLimiter {
	const entries = new Map<string, { until: number; running: boolean }>();
	return {
		claim(name, now) {
			for (const [key, entry] of entries) {
				if (!entry.running && entry.until <= now) entries.delete(key);
			}
			const held = entries.get(name);
			if (held) return Math.max(1, Math.ceil((held.until - now) / 1000));
			entries.set(name, { until: now + REFRESH_WINDOW_MS, running: true });
			return undefined;
		},
		release(name) {
			const held = entries.get(name);
			if (held) held.running = false;
		},
		size: () => entries.size,
	};
}

export type RefreshDeps = {
	which(name: string, env?: { PATH?: string; cwd?: string }): string | null;
	runSource: RunSource;
	now: () => number;
	limiter: RefreshLimiter;
	logger: Pick<Logger, "warn">;
};

export type RefreshResult =
	| { ok: true; updatedAt: string }
	| { ok: false; status: 409 | 429 | 502; error: string; retryAfter?: number };

type Store = Pick<CredentialStore, "listCredentials" | "setCredential">;

const PROVIDER = "aws-secretsmanager";
const CREATED_BY = "service api refresh";

function toSource(raw: unknown): SecretSource | undefined {
	if (!isRecord(raw) || raw.type !== PROVIDER) return undefined;
	const { secretId, region, key, profile } = raw;
	if (typeof secretId !== "string" || typeof region !== "string") return undefined;
	if (key !== undefined && typeof key !== "string") return undefined;
	if (profile !== undefined && typeof profile !== "string") return undefined;
	return {
		type: PROVIDER,
		secretId,
		region,
		...(key === undefined ? {} : { key }),
		...(profile === undefined ? {} : { profile }),
	};
}

function recordedSource(
	paths: Pick<DgPaths, "jobSourcesPath">,
	job: JobDecl,
	rest: string,
): SecretSource | undefined {
	const found = findRecordByJob(readSourceRecords(paths), job.name);
	if (!found || found.source !== job.grant) return undefined;
	if (found.record.setupDone?.includes(job.name) !== true) return undefined;
	const details = Object.entries(found.record.credentials).findLast(
		([key]) => key.toLowerCase() === rest,
	);
	return toSource(isRecord(details?.[1]) ? details[1].source : undefined);
}

const absolutePath = (value: string | undefined): string =>
	(value ?? "")
		.split(delimiter)
		.filter((entry) => isAbsolute(entry))
		.join(delimiter);

const failed = (job: string, text: string): RefreshResult => ({
	ok: false,
	status: 502,
	error: `${text} — run dg job setup ${job} --refresh`,
});

function fetchFailure(job: string, name: string, key: string | undefined, err: unknown): RefreshResult {
	if (!(err instanceof SecretFetchError)) throw err;
	switch (err.kind) {
		case "not-installed":
			return failed(job, `aws is not on the PATH of job "${job}"`);
		case "timeout":
			return failed(job, `aws timed out for ${name}`);
		case "no-text":
			return failed(job, `the secret of ${name} has no text value`);
		case "invalid-json":
			return failed(job, `the secret of ${name} is not JSON`);
		case "no-key":
			return failed(job, `the secret has no key "${sanitize(key ?? "")}"`);
		case "failed":
			return failed(job, `aws failed for ${name}: ${sanitize(err.message).slice(0, MAX_LINE)}`);
	}
}

/** Fetches the recorded source of one credential of a job and stores the value; it returns no value. */
export async function refreshCredential({
	paths,
	store,
	job,
	name,
	deps,
}: {
	paths: Pick<DgPaths, "jobSourcesPath" | "jobStateRoot">;
	store: Store;
	job: JobDecl;
	name: string;
	deps: RefreshDeps;
}): Promise<RefreshResult> {
	const canonical = validateCredentialName(name);
	const rest = canonical.slice(`${job.grant}/`.length);
	const source = job.credentials.includes(rest) ? recordedSource(paths, job, rest) : undefined;
	if (!source) {
		return {
			ok: false,
			status: 409,
			error: `credential "${name}" has no source — run dg job setup ${job.name}`,
		};
	}
	let env: Record<string, string>;
	try {
		env = buildBaseEnv(job, deps);
	} catch {
		return failed(job.name, `the env file of job "${job.name}" cannot be read`);
	}
	const retryAfter = deps.limiter.claim(canonical, deps.now());
	if (retryAfter !== undefined) {
		return {
			ok: false,
			status: 429,
			error: `refresh of ${name} is limited — try again in ${retryAfter} s`,
			retryAfter,
		};
	}
	try {
		const cwd = jobStateDir(paths, job.name);
		ensurePrivateDir(cwd);
		const searchPath = absolutePath(env.PATH);
		let value: string;
		try {
			value = await fetchSecret(source, {
				which: (program) => {
					const found = deps.which(program, { PATH: searchPath });
					return found !== null && isAbsolute(found) ? found : null;
				},
				runSource: deps.runSource,
				env,
				cwd,
			});
		} catch (err) {
			return fetchFailure(job.name, canonical, source.key, err);
		}
		noteSecret(value);
		try {
			validateCredentialValue(value);
		} catch {
			return failed(job.name, `the secret of ${canonical} is not a valid credential value`);
		}
		const before = store.listCredentials().find((entry) => entry.name === canonical);
		store.setCredential(canonical, value, {
			...before?.meta,
			provider: PROVIDER,
			createdBy: CREATED_BY,
		});
		const after = store.listCredentials().find((entry) => entry.name === canonical);
		return { ok: true, updatedAt: after?.updatedAt ?? new Date(deps.now()).toISOString() };
	} finally {
		deps.limiter.release(canonical);
	}
}
