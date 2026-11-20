import { existsSync, readFileSync } from "node:fs";
import { describeError, isRecord } from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	isJobName,
	writeFilePreserving,
} from "@dg/common/node";

export type GitSourceRecord = {
	kind: "git";
	url: string;
	ref: string | null;
	sha: string;
	jobs: string[];
	declarationHash: string;
	credentials: Record<string, unknown>;
};

export type SourceRegistry = Record<string, GitSourceRecord>;

const SHA = /^[0-9a-f]{40}$/;

function checkRecord(file: string, source: string, raw: unknown): GitSourceRecord {
	const bad = (why: string): never => {
		throw new Error(`${file}: source "${source}" ${why}`);
	};
	if (!isRecord(raw)) return bad("is not an object");
	if (raw.kind !== "git") bad('has a "kind" that is not "git"');
	if (typeof raw.url !== "string" || raw.url.startsWith("-")) {
		bad('has a "url" that is not a string or starts with "-"');
	}
	if (raw.ref !== null && typeof raw.ref !== "string") {
		bad('has a "ref" that is not a string or null');
	}
	if (typeof raw.sha !== "string" || !SHA.test(raw.sha)) {
		bad('has a "sha" that is not 40 hexadecimal characters');
	}
	if (
		!Array.isArray(raw.jobs) ||
		!raw.jobs.every((job) => typeof job === "string" && isJobName(job))
	) {
		bad('has "jobs" that is not an array of job names');
	}
	if (typeof raw.declarationHash !== "string") {
		bad('has a "declarationHash" that is not a string');
	}
	if (!isRecord(raw.credentials)) bad('has "credentials" that is not an object');
	return raw as GitSourceRecord;
}

export function readSources(paths: Pick<DgPaths, "jobSourcesPath">): SourceRegistry {
	const file = paths.jobSourcesPath;
	if (!existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`${file} is not valid JSON: ${describeError(err)}`);
	}
	if (!isRecord(parsed)) throw new Error(`${file} must be a JSON object keyed by source name`);
	return Object.fromEntries(
		Object.entries(parsed).map(([source, raw]) => {
			if (!isJobName(source)) throw new Error(`${file}: source "${source}" is not a valid source name`);
			return [source, checkRecord(file, source, raw)];
		}),
	);
}

/** Sets or, given undefined, removes one record and keeps the others. */
export function writeSource(
	paths: Pick<DgPaths, "jobsDir" | "jobSourcesPath">,
	source: string,
	record: GitSourceRecord | undefined,
): void {
	const current = readSources(paths);
	const kept = Object.entries(current).filter(([key]) => key !== source);
	const next = Object.fromEntries(record === undefined ? kept : [...kept, [source, record]]);
	ensurePrivateDir(paths.jobsDir);
	writeFilePreserving(paths.jobSourcesPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

export function findRecordByJob(
	registry: SourceRegistry,
	job: string,
): { source: string; record: GitSourceRecord } | undefined {
	const hit = Object.entries(registry).find(([, record]) => record.jobs.includes(job));
	return hit && { source: hit[0], record: hit[1] };
}
