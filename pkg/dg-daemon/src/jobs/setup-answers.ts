import { isRecord } from "@dg/common";
import { sanitize } from "./sanitize";

type Meta = Record<string, string>;
type Extras = { meta?: Meta; expiresAt?: string };

export type SetupAnswer = Extras &
	(
		| { kind: "value"; value: string }
		| { kind: "source"; profile?: string }
		| { kind: "keep" }
		| { kind: "skip" }
	);

export type ParsedSetup =
	| { ok: true; answers: Record<string, SetupAnswer> }
	| { ok: false; error: string };

export type AnswerContext = {
	name: string;
	required: boolean;
	hasSource: boolean;
	state: "stored" | "expired" | "missing";
};

const TOP_KEYS = ["version", "credentials"];
const ANSWER_KEYS = ["value", "source", "keep", "skip", "meta", "expiresAt"];
const KINDS = ["value", "source", "keep", "skip"];
const UNSAFE_NAMES = ["__proto__", "constructor", "prototype"];
const KIND_LIST = '"value", "source", "keep" and "skip"';

class Refusal extends Error {}

const refuse = (message: string): never => {
	throw new Refusal(`--setup: ${message}`);
};

const quote = (text: string): string => `"${sanitize(text)}"`;

function readMeta(name: string, raw: unknown): Meta {
	const fail = () => refuse(`"meta" for ${quote(name)} must map keys to text`);
	if (!isRecord(raw)) return fail();
	const meta = Object.create(null) as Meta;
	for (const [key, value] of Object.entries(raw)) {
		if (UNSAFE_NAMES.includes(key) || typeof value !== "string") fail();
		meta[key] = value as string;
	}
	return meta;
}

function readSource(name: string, raw: unknown): { kind: "source"; profile?: string } {
	if (raw === true) return { kind: "source" };
	const keys = isRecord(raw) ? Object.keys(raw) : [];
	if (!isRecord(raw) || keys.length === 0 || keys.some((key) => key !== "profile")) {
		return refuse(`"source" for ${quote(name)} must be true or an object with "profile"`);
	}
	const { profile } = raw;
	if (typeof profile !== "string" || profile === "" || profile.startsWith("-")) {
		return refuse(`the "profile" for ${quote(name)} is not valid`);
	}
	return { kind: "source", profile };
}

function readAnswer(name: string, raw: unknown): SetupAnswer {
	if (!isRecord(raw)) return refuse(`the answer for ${quote(name)} must be an object`);
	for (const key of Object.keys(raw)) {
		if (!ANSWER_KEYS.includes(key)) {
			refuse(`unknown key ${quote(key)} in the answer for ${quote(name)}`);
		}
	}
	const given = KINDS.filter((kind) => Object.hasOwn(raw, kind));
	if (given.length > 1) refuse(`the answer for ${quote(name)} gives more than one of ${KIND_LIST}`);
	if (given.length === 0) refuse(`the answer for ${quote(name)} gives none of ${KIND_LIST}`);
	const extras: Extras = {};
	if (raw.meta !== undefined) extras.meta = readMeta(name, raw.meta);
	if (raw.expiresAt !== undefined) {
		if (typeof raw.expiresAt !== "string") refuse(`"expiresAt" for ${quote(name)} must be text`);
		extras.expiresAt = raw.expiresAt as string;
	}
	const [kind] = given;
	if ((kind === "keep" || kind === "skip") && Object.keys(extras).length > 0) {
		refuse(`"meta" and "expiresAt" do not apply to the "${kind}" answer for ${quote(name)}`);
	}
	if (kind === "value") {
		if (typeof raw.value !== "string" || raw.value === "") {
			refuse(`"value" for ${quote(name)} must be a non-empty text`);
		}
		return { kind, value: raw.value as string, ...extras };
	}
	if (kind === "source") return { ...readSource(name, raw.source), ...extras };
	if (raw[kind] !== true) refuse(`"${kind}" for ${quote(name)} must be true`);
	return { kind: kind as "keep" | "skip" };
}

/** Reads the --setup JSON into answers; an error text never holds a value. */
export function parseSetupAnswers(
	text: string,
	job: { job: string; credentials: string[] },
): ParsedSetup {
	try {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Refusal("--setup is not valid JSON");
		}
		if (!isRecord(parsed)) throw new Refusal("--setup must be a JSON object");
		for (const key of Object.keys(parsed)) {
			if (!TOP_KEYS.includes(key)) refuse(`unknown key ${quote(key)}`);
		}
		if (parsed.version !== 1) refuse('"version" must be 1');
		const raw = parsed.credentials ?? {};
		if (!isRecord(raw)) return refuse('"credentials" must be an object');
		const answers = Object.create(null) as Record<string, SetupAnswer>;
		for (const [name, value] of Object.entries(raw)) {
			if (UNSAFE_NAMES.includes(name)) refuse(`${quote(name)} is not a valid credential name`);
			if (!job.credentials.includes(name)) {
				refuse(`${quote(name)} is not a credential of job ${quote(job.job)}`);
			}
			answers[name] = readAnswer(name, value);
		}
		return { ok: true, answers };
	} catch (err) {
		if (err instanceof Refusal) return { ok: false, error: err.message };
		throw err;
	}
}

/** Checks each answer against the state of its credential; it returns the first error. */
export function checkAnswers(
	answers: Record<string, SetupAnswer>,
	contexts: AnswerContext[],
): string | undefined {
	for (const { name, required, hasSource, state } of contexts) {
		const answer = Object.hasOwn(answers, name) ? answers[name] : undefined;
		if (answer === undefined) continue;
		if (answer.kind === "source" && !hasSource) return `--setup: ${quote(name)} has no source`;
		if (answer.kind === "skip" && required && state === "missing") {
			return `--setup: ${quote(name)} is required and missing, so "skip" does not fit`;
		}
		if (answer.kind === "keep" && state === "missing") {
			return `--setup: ${quote(name)} is missing, so "keep" does not fit`;
		}
	}
	return undefined;
}
