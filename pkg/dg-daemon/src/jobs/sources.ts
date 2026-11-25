import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describeError, isRecord } from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	isJobName,
	writeFilePreserving,
} from "@dg/common/node";

export type SourcePin = { kind: "sha256" | "commit"; value: string };

export type SourceMarks = { prefixAccepted?: boolean; setupDone?: string[] };

export type GitSourceRecord = {
	kind: "git";
	url: string;
	ref: string | null;
	sha: string;
	jobs: string[];
	declarationHash: string;
	credentials: Record<string, unknown>;
	pin?: SourcePin;
} & SourceMarks;

export type PathSourceRecord = {
	kind: "path";
	path: string;
	jobs: string[];
	declarationHash?: string;
	credentials: Record<string, unknown>;
	pin?: SourcePin;
} & SourceMarks;

export type CommandSourceRecord = { kind: "command" } & SourceMarks;

export type SourceRecord = GitSourceRecord | PathSourceRecord | CommandSourceRecord;

export type NamedRegistry = Record<string, GitSourceRecord | PathSourceRecord>;

export type RecordRegistry = Record<string, SourceRecord>;

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const MARK_KEYS = ["prefixAccepted", "setupDone"];
const KEYS = {
	git: ["kind", "url", "ref", "sha", "jobs", "declarationHash", "credentials", "pin", ...MARK_KEYS],
	path: ["kind", "path", "jobs", "declarationHash", "credentials", "pin", ...MARK_KEYS],
	command: ["kind", ...MARK_KEYS],
};

function checkPin(raw: Record<string, unknown>, bad: (why: string) => never): void {
	const pin = raw.pin;
	if (pin === undefined) return;
	const ok =
		isRecord(pin) &&
		Object.keys(pin).length === 2 &&
		(pin.kind === "sha256" || pin.kind === "commit") &&
		typeof pin.value === "string" &&
		/^[0-9a-f]+$/.test(pin.value);
	if (!ok) bad('has a "pin" that is not a sha256 or commit pin');
}

function checkPathRecord(
	raw: Record<string, unknown>,
	bad: (why: string) => never,
): PathSourceRecord {
	if (typeof raw.path !== "string" || !isAbsolute(raw.path)) {
		bad('has a "path" that is not an absolute path');
	}
	if (!Array.isArray(raw.jobs) || !raw.jobs.every((job) => typeof job === "string" && isJobName(job))) {
		bad('has "jobs" that is not an array of job names');
	}
	const hash = raw.declarationHash;
	if (hash !== undefined && !(typeof hash === "string" && HASH.test(hash))) {
		bad('has a "declarationHash" that is not 64 hexadecimal characters');
	}
	if (!isRecord(raw.credentials)) bad('has "credentials" that is not an object');
	checkPin(raw, bad);
	return raw as PathSourceRecord;
}

function checkRecord(file: string, source: string, raw: unknown): SourceRecord {
	const bad = (why: string): never => {
		throw new Error(`the record of "${source}" in ${file} is not valid: it ${why}`);
	};
	if (!isRecord(raw)) return bad("is not an object");
	if (raw.kind !== "git" && raw.kind !== "path" && raw.kind !== "command") {
		bad('has a "kind" that is not "git", "path" or "command"');
	}
	const kind = raw.kind as keyof typeof KEYS;
	const stray = Object.keys(raw).find((key) => !KEYS[kind].includes(key));
	if (stray !== undefined) bad(`has the unknown key ${JSON.stringify(stray)}`);
	if (raw.prefixAccepted !== undefined && typeof raw.prefixAccepted !== "boolean") {
		bad('has a "prefixAccepted" that is not a boolean');
	}
	if (
		raw.setupDone !== undefined &&
		!(
			Array.isArray(raw.setupDone) &&
			raw.setupDone.every((job) => typeof job === "string" && isJobName(job))
		)
	) {
		bad('has a "setupDone" that is not an array of job names');
	}
	if (kind === "command") return raw as CommandSourceRecord;
	if (kind === "path") return checkPathRecord(raw, bad);
	if (typeof raw.url !== "string" || raw.url.startsWith("-")) {
		bad('has a "url" that is not a string or starts with "-"');
	}
	if (raw.ref !== null && typeof raw.ref !== "string") {
		bad('has a "ref" that is not a string or null');
	}
	if (typeof raw.ref === "string" && raw.ref.startsWith("-")) {
		bad('has a "ref" that starts with "-"');
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
	checkPin(raw, bad);
	return raw as GitSourceRecord;
}

export function readSourceRecords(paths: Pick<DgPaths, "jobSourcesPath">): RecordRegistry {
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

/** The repository and path records: each source name that holds a credential prefix. */
export function readNamedSources(paths: Pick<DgPaths, "jobSourcesPath">): NamedRegistry {
	return Object.fromEntries(
		Object.entries(readSourceRecords(paths)).filter(
			(entry): entry is [string, GitSourceRecord | PathSourceRecord] => entry[1].kind !== "command",
		),
	);
}

/** Sets or, given undefined, removes one record and keeps the others. */
export function writeSource(
	paths: Pick<DgPaths, "jobsDir" | "jobSourcesPath">,
	source: string,
	record: SourceRecord | undefined,
): void {
	const current = readSourceRecords(paths);
	const kept = Object.entries(current).filter(([key]) => key !== source);
	const next = Object.fromEntries(record === undefined ? kept : [...kept, [source, record]]);
	ensurePrivateDir(paths.jobsDir);
	writeFilePreserving(paths.jobSourcesPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

export function findRecordByJob(
	registry: RecordRegistry,
	job: string,
): { source: string; record: GitSourceRecord | PathSourceRecord } | undefined {
	for (const [source, record] of Object.entries(registry)) {
		if (record.kind !== "command" && record.jobs.includes(job)) return { source, record };
	}
	return undefined;
}

/** Finds the record that holds the marks of a job: its repository record, or its own command record. */
export function findMarkRecord(
	registry: RecordRegistry,
	job: string,
): { source: string; record: SourceRecord } | undefined {
	const git = findRecordByJob(registry, job);
	if (git) return git;
	const own = Object.hasOwn(registry, job) ? registry[job] : undefined;
	return own?.kind === "command" ? { source: job, record: own } : undefined;
}

export function updateMarks(
	paths: Pick<DgPaths, "jobsDir" | "jobSourcesPath">,
	job: string,
	change: { prefixAccepted?: true; setupDone?: string },
): void {
	const found = findMarkRecord(readSourceRecords(paths), job);
	const record: SourceRecord = found?.record ?? { kind: "command" };
	const done = record.setupDone ?? [];
	const accept = change.prefixAccepted === true && record.prefixAccepted !== true;
	const finish = change.setupDone !== undefined && !done.includes(change.setupDone);
	if (found && !accept && !finish) return;
	writeSource(paths, found?.source ?? job, {
		...record,
		...(accept ? { prefixAccepted: true } : {}),
		...(finish ? { setupDone: [...done, change.setupDone as string] } : {}),
	});
}
