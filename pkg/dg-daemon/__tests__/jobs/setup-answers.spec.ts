import { describe, expect, it } from "bun:test";
import {
	type AnswerContext,
	checkAnswers,
	parseSetupAnswers,
	type SetupAnswer,
} from "../../src/jobs/setup-answers";

const NAMES = ["api/dev", "metrics", "errors"];
const parse = (value: unknown, names = NAMES) =>
	parseSetupAnswers(typeof value === "string" ? value : JSON.stringify(value), {
		job: "bot",
		credentials: names,
	});
const wrap = (credentials: unknown) => ({ version: 1, credentials });
const errorOf = (value: unknown, names?: string[]) => {
	const result = parse(value, names);
	if (result.ok) throw new Error("parsed");
	return result.error;
};

describe("parseSetupAnswers", () => {
	it("parses the four answer kinds with meta and expiresAt", () => {
		const result = parse(
			wrap({
				"api/dev": { source: { profile: "p" } },
				metrics: { value: "v", meta: { site: "s" }, expiresAt: "2030-01-01T00:00:00Z" },
				errors: { skip: true },
			}),
		);

		expect(result).toEqual({
			ok: true,
			answers: {
				"api/dev": { kind: "source", profile: "p" },
				metrics: {
					kind: "value",
					value: "v",
					meta: { site: "s" },
					expiresAt: "2030-01-01T00:00:00Z",
				},
				errors: { kind: "skip" },
			},
		});
	});

	it("parses source true and keep true", () => {
		const result = parse(wrap({ metrics: { source: true }, errors: { keep: true } }));
		expect(result).toEqual({
			ok: true,
			answers: { metrics: { kind: "source" }, errors: { kind: "keep" } },
		});
	});

	it("builds answers and meta objects with no prototype", () => {
		const result = parse(wrap({ metrics: { value: "v", meta: { site: "s" } } }));
		if (!result.ok) throw new Error(result.error);
		const answer = result.answers.metrics as SetupAnswer & { meta: object };
		expect(Object.getPrototypeOf(result.answers)).toBeNull();
		expect(Object.getPrototypeOf(answer.meta)).toBeNull();
	});

	it("takes an empty credentials object and a missing one", () => {
		expect(parse({ version: 1, credentials: {} }).ok).toBe(true);
		expect(parse({ version: 1 }).ok).toBe(true);
	});

	it.each([
		["text that is not JSON", "not json{", "--setup is not valid JSON"],
		["an array", [], "--setup must be a JSON object"],
		["a missing version", { credentials: {} }, '--setup: "version" must be 1'],
		["version 2", { version: 2 }, '--setup: "version" must be 1'],
		["an unknown top-level key", { version: 1, extra: 1 }, '--setup: unknown key "extra"'],
		["credentials as an array", { version: 1, credentials: [] }, '--setup: "credentials" must be an object'],
		[
			"an unknown credential name",
			wrap({ nope: { skip: true } }),
			'--setup: "nope" is not a credential of job "bot"',
		],
		[
			"an unknown answer key",
			wrap({ metrics: { value: "v", extra: 1 } }),
			'--setup: unknown key "extra" in the answer for "metrics"',
		],
		[
			"two answer kinds",
			wrap({ metrics: { value: "v", skip: true } }),
			'--setup: the answer for "metrics" gives more than one of "value", "source", "keep" and "skip"',
		],
		[
			"no answer kind",
			wrap({ metrics: { meta: { site: "s" } } }),
			'--setup: the answer for "metrics" gives none of "value", "source", "keep" and "skip"',
		],
		["an answer that is a string", wrap({ metrics: "v" }), '--setup: the answer for "metrics" must be an object'],
		["an empty value", wrap({ metrics: { value: "" } }), '--setup: "value" for "metrics" must be a non-empty text'],
		["a value that is a number", wrap({ metrics: { value: 1 } }), '--setup: "value" for "metrics" must be a non-empty text'],
		["keep false", wrap({ metrics: { keep: false } }), '--setup: "keep" for "metrics" must be true'],
		["skip as text", wrap({ metrics: { skip: "yes" } }), '--setup: "skip" for "metrics" must be true'],
		["source false", wrap({ metrics: { source: false } }), '--setup: "source" for "metrics" must be true or an object with "profile"'],
		[
			"a source with another key",
			wrap({ metrics: { source: { secretId: "x" } } }),
			'--setup: "source" for "metrics" must be true or an object with "profile"',
		],
		["a profile that starts with a dash", wrap({ metrics: { source: { profile: "-x" } } }), '--setup: the "profile" for "metrics" is not valid'],
		["an empty profile", wrap({ metrics: { source: { profile: "" } } }), '--setup: the "profile" for "metrics" is not valid'],
		["meta with a number", wrap({ metrics: { value: "v", meta: { site: 1 } } }), '--setup: "meta" for "metrics" must map keys to text'],
		["meta that is a string", wrap({ metrics: { value: "v", meta: "s" } }), '--setup: "meta" for "metrics" must map keys to text'],
		["an expiresAt that is a number", wrap({ metrics: { value: "v", expiresAt: 5 } }), '--setup: "expiresAt" for "metrics" must be text'],
		[
			"meta on a skip answer",
			wrap({ metrics: { skip: true, meta: { site: "s" } } }),
			'--setup: "meta" and "expiresAt" do not apply to the "skip" answer for "metrics"',
		],
	])("refuses %s", (_label, input, message) => {
		expect(errorOf(input)).toBe(message);
	});

	it.each(["__proto__", "constructor", "prototype"])("refuses the credential name %s", (name) => {
		const text = `{"version":1,"credentials":{${JSON.stringify(name)}:{"skip":true}}}`;
		expect(errorOf(text, [name])).toBe(`--setup: "${name}" is not a valid credential name`);
	});

	it.each(["__proto__", "constructor", "prototype"])("refuses the meta key %s", (key) => {
		const text = `{"version":1,"credentials":{"metrics":{"value":"v","meta":{${JSON.stringify(key)}:"x"}}}}`;
		expect(errorOf(text)).toBe(`--setup: "meta" for "metrics" must map keys to text`);
	});

	it("does not echo the secret value in an error", () => {
		const message = errorOf(wrap({ metrics: { value: "hunter2-secret", skip: true } }));
		expect(message).not.toContain("hunter2");
	});

	it("sanitizes control characters in names it prints", () => {
		expect(errorOf(wrap({ "a\u001b[31m": { skip: true } }))).not.toContain("\u001b");
	});
});

describe("checkAnswers", () => {
	const context = (over: Partial<AnswerContext> = {}): AnswerContext => ({
		name: "metrics",
		required: true,
		hasSource: false,
		state: "missing",
		...over,
	});
	const check = (answer: SetupAnswer, over?: Partial<AnswerContext>) =>
		checkAnswers({ metrics: answer }, [context(over)]);

	it("returns nothing for answers that fit", () => {
		expect(check({ kind: "value", value: "v" })).toBeUndefined();
		expect(check({ kind: "skip" }, { required: false })).toBeUndefined();
		expect(check({ kind: "keep" }, { state: "stored" })).toBeUndefined();
		expect(check({ kind: "source" }, { hasSource: true })).toBeUndefined();
		expect(check({ kind: "skip" }, { state: "stored" })).toBeUndefined();
	});

	it("refuses skip on a required credential that is missing", () => {
		expect(check({ kind: "skip" })).toBe(
			'--setup: "metrics" is required and missing, so "skip" does not fit',
		);
	});

	it("refuses keep on a credential that is missing", () => {
		expect(check({ kind: "keep" }, { required: false })).toBe(
			'--setup: "metrics" is missing, so "keep" does not fit',
		);
	});

	it("refuses source true and a source profile on a credential with no source", () => {
		const message = '--setup: "metrics" has no source';
		expect(check({ kind: "source" })).toBe(message);
		expect(check({ kind: "source", profile: "p" })).toBe(message);
	});
});
