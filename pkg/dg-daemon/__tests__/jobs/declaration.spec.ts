import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	declarationHash,
	describeCredentials,
	parseJobDeclaration,
} from "../../src/jobs/declaration";
import { parseJobEntry } from "../../src/jobs/config";

const SOURCE_DIR = "/data/jobs/tools";
const stateDir = (name: string) => join("/state/jobs", name);
const context = { source: "tools", sourceDir: SOURCE_DIR, stateDir };

const job = (extra: Record<string, unknown> = {}) => ({
	argv: ["bun", "run", "bot.ts"],
	continuous: true,
	...extra,
});
const parse = (dg: unknown) => parseJobDeclaration({ dg }, context);
const errorOf = (dg: unknown): string => {
	const result = parse(dg);
	if (result.ok) throw new Error("expected a refusal");
	return result.error;
};

describe("parseJobDeclaration", () => {
	it("gives one entry with cwd set to the clone directory", () => {
		const result = parse({ jobs: { "bot-dev": job() } });

		expect(result).toEqual({
			ok: true,
			jobs: [
				{
					name: "bot-dev",
					entry: { argv: ["bun", "run", "bot.ts"], continuous: true, cwd: SOURCE_DIR },
				},
			],
			credentials: {},
			requires: [],
			build: undefined,
		});
	});

	it("does not throw for a value that is not an object", () => {
		for (const bad of [null, 1, "x", [], undefined]) {
			expect(parseJobDeclaration(bad, context).ok).toBe(false);
			expect(parse(bad).ok).toBe(false);
		}
	});

	it("reports a package.json with no dg key", () => {
		const result = parseJobDeclaration({ name: "x" }, context);
		expect(result.ok).toBe(false);
	});

	it("passes each entry through parseJobEntry", () => {
		const result = parse({ jobs: { a: job(), b: { argv: ["x"], every: "15m" } } });
		if (!result.ok) throw new Error(result.error);
		for (const { name, entry } of result.jobs) {
			expect(parseJobEntry(name, entry).ok).toBe(true);
		}
	});

	it("names the keys of a dg block that are not accepted", () => {
		expect(errorOf({ jobs: { a: job() }, other: 1, more: 2 })).toBe(
			"unknown key(s): other, more",
		);
	});

	it("names the keys of a job that are not accepted", () => {
		expect(errorOf({ jobs: { a: job({ weird: 1 }) } })).toBe(
			'job "a": unknown key(s): weird',
		);
	});

	it.each(["grant", "cwd", "enabled", "passEnv", "credentialEnv"])(
		"refuses the job key %s by name",
		(key) => {
			expect(errorOf({ jobs: { a: job({ [key]: "x" }) } })).toBe(
				`job "a": the key "${key}" is set by dg`,
			);
		},
	);

	it("prefixes the validator error with the job name", () => {
		expect(errorOf({ jobs: { a: { argv: ["x"] } } })).toBe(
			'job "a": give exactly one of "continuous", "schedule" or "every"',
		);
	});

	it("gives grant to a job that lists credentials and none to one that does not", () => {
		const result = parse({
			jobs: { a: job({ credentials: ["token-a"] }), b: job() },
		});
		if (!result.ok) throw new Error(result.error);
		expect(result.jobs[0].entry.grant).toBe("tools");
		expect(result.jobs[0].entry.credentials).toEqual(["token-a"]);
		expect(result.jobs[1].entry).not.toHaveProperty("grant");
	});

	it("gives no grant and no credentials key for an empty list", () => {
		const result = parse({ jobs: { a: job({ credentials: [] }) } });
		if (!result.ok) throw new Error(result.error);
		expect(result.jobs[0].entry).not.toHaveProperty("grant");
		expect(result.jobs[0].entry).not.toHaveProperty("credentials");
	});

	it("refuses a credentials value that is not an array", () => {
		expect(errorOf({ jobs: { a: job({ credentials: "x" }) } })).toBe(
			'job "a": "credentials" must be an array of credential names',
		);
	});

	it("refuses a name that is in one job list two times", () => {
		expect(errorOf({ jobs: { a: job({ credentials: ["x", "x"] }) } })).toBe(
			'job "a": "credentials" must not list a name two times',
		);
	});

	it("refuses two credential keys that differ only in letter case", () => {
		expect(
			errorOf({
				jobs: { a: job({ credentials: ["token"] }) },
				credentials: { Token: { prompt: "one" }, token: { prompt: "two" } },
			}),
		).toBe('credential "token" is declared two times in "credentials" (names ignore letter case)');
	});

	it("keeps a scheduled entry as the block gives it", () => {
		const result = parse({
			jobs: { a: { argv: ["x"], every: "15m", feed: true, notify: "me", timeoutMs: 5 } },
		});
		if (!result.ok) throw new Error(result.error);
		expect(result.jobs[0].entry).toEqual({
			argv: ["x"],
			every: "15m",
			feed: true,
			notify: "me",
			timeoutMs: 5,
			cwd: SOURCE_DIR,
		});
	});

	describe("envFile", () => {
		it("resolves a relative path below the state folder of the job", () => {
			const result = parse({ jobs: { a: job({ envFile: "bot.env" }) } });
			if (!result.ok) throw new Error(result.error);
			expect(result.jobs[0].entry.envFile).toBe(join("/state/jobs/a", "bot.env"));
		});

		it.each(["/abs/bot.env", "../bot.env", "a/../../bot.env", ".", "", "C:\\x\\bot.env"])(
			"refuses %p",
			(envFile) => {
				expect(errorOf({ jobs: { a: job({ envFile }) } })).toBe(
					'job "a": "envFile" must be a relative path inside the state folder of the job',
				);
			},
		);

		it("refuses an envFile that is not a string", () => {
			expect(errorOf({ jobs: { a: job({ envFile: 3 }) } })).toBe(
				'job "a": "envFile" must be a relative path inside the state folder of the job',
			);
		});
	});

	describe("argv[0]", () => {
		it("stays inside the repository for a name with a separator", () => {
			const result = parse({ jobs: { a: job({ argv: ["./bin/run"] }) } });
			if (!result.ok) throw new Error(result.error);
			expect(result.jobs[0].entry.argv).toEqual(["./bin/run"]);
		});

		it.each(["../x", "/usr/bin/tool", "bin/../../x"])("refuses %p", (first) => {
			expect(errorOf({ jobs: { a: job({ argv: [first] }) } })).toBe(
				'job "a": "argv" must stay inside the repository',
			);
		});
	});

	describe("requires and build", () => {
		it("returns both as written", () => {
			const result = parse({
				jobs: { a: job() },
				requires: ["git", "bun"],
				build: ["bun", "install"],
			});
			if (!result.ok) throw new Error(result.error);
			expect(result.requires).toEqual(["git", "bun"]);
			expect(result.build).toEqual(["bun", "install"]);
		});

		it.each([["x"], [[1]], [["a/b"]], [["a\\b"]], [[""]], [{}]])(
			"refuses requires %p",
			(requires) => {
				expect(errorOf({ jobs: { a: job() }, requires })).toBe(
					'"requires" must be an array of executable names',
				);
			},
		);

		it.each([["x"], [[]], [[""]], [[1]], [{}]])("refuses build %p", (build) => {
			expect(errorOf({ jobs: { a: job() }, build })).toBe(
				'"build" must be a non-empty array of non-empty strings',
			);
		});
	});

	describe("credentials", () => {
		const withDetails = (details: unknown, list: string[] = ["a"]) => ({
			jobs: { j: job({ credentials: list }) },
			credentials: details,
		});

		it("accepts prompt, required, meta and source", () => {
			const details = {
				a: {
					prompt: "Token for the bot",
					required: false,
					meta: { site: { prompt: "Site", default: "x.example" } },
					source: {
						type: "aws-secretsmanager",
						secretId: "bots/a",
						region: "us-east-1",
						key: "token",
						profile: "bot",
					},
				},
			};
			const result = parse(withDetails(details));
			if (!result.ok) throw new Error(result.error);
			expect(result.credentials).toEqual(details);
		});

		it("refuses a details key that no job lists", () => {
			expect(errorOf(withDetails({ extra: { prompt: "x" } }))).toBe(
				'credential "extra" is not in the "credentials" list of a job',
			);
		});

		it("refuses a source of type command", () => {
			expect(
				errorOf(withDetails({ a: { source: { type: "command", secretId: "x", region: "r" } } })),
			).toBe('credential "a": unknown source type "command"');
		});

		it("refuses a source of type azure-keyvault", () => {
			expect(errorOf(withDetails({ a: { source: { type: "azure-keyvault" } } }))).toBe(
				'credential "a": unknown source type "azure-keyvault"',
			);
		});

		it("refuses a source with no type", () => {
			expect(errorOf(withDetails({ a: { source: { secretId: "x" } } }))).toBe(
				'credential "a": unknown source type (missing)',
			);
		});

		it.each([
			["secretId", "-x"],
			["region", "-x"],
			["region", "US_EAST"],
			["secretId", 3],
			["secretId", ""],
		])("refuses %s %p", (key, value) => {
			const source = { type: "aws-secretsmanager", secretId: "x", region: "us-east-1", [key]: value };
			expect(errorOf(withDetails({ a: { source } }))).toBe(
				`credential "a": "${key}" is not valid`,
			);
		});

		it.each(["key", "profile"])("refuses an optional %s that starts with a dash", (key) => {
			const source = { type: "aws-secretsmanager", secretId: "x", region: "r", [key]: "-p" };
			expect(errorOf(withDetails({ a: { source } }))).toBe(
				`credential "a": "${key}" is not valid`,
			);
		});

		it("names a source key that is not accepted", () => {
			const source = { type: "aws-secretsmanager", secretId: "x", region: "r", command: "id" };
			expect(errorOf(withDetails({ a: { source } }))).toBe(
				'credential "a": unknown key "command" in "source"',
			);
		});

		it.each([
			["apiToken", "looks like a secret"],
			["value", "looks like a secret"],
			["mySecret", "looks like a secret"],
			["password", "looks like a secret"],
			["provider", "is set by dg"],
			["createdBy", "is set by dg"],
		])("refuses the meta key %s", (key, why) => {
			expect(errorOf(withDetails({ a: { meta: { [key]: { prompt: "x" } } } }))).toBe(
				`credential "a": the meta key "${key}" ${why}`,
			);
		});

		it("says apiToken looks like a secret", () => {
			expect(errorOf(withDetails({ a: { meta: { apiToken: { prompt: "x" } } } }))).toBe(
				'credential "a": the meta key "apiToken" looks like a secret',
			);
		});

		it.each(["scopes", "expiresAt"])("refuses the meta key %s", (key) => {
			expect(errorOf(withDetails({ a: { meta: { [key]: { prompt: "x" } } } }))).toBe(
				`credential "a": the meta key "${key}" cannot be given as text`,
			);
		});

		it("refuses a details key that is not accepted", () => {
			expect(errorOf(withDetails({ a: { prompt: "x", weird: 1 } }))).toBe(
				'credential "a": unknown key(s): weird',
			);
		});

		it("refuses a required value that is not a boolean", () => {
			expect(errorOf(withDetails({ a: { required: "yes" } }))).toBe(
				'credential "a": "required" must be a boolean',
			);
		});

		it("accepts env and gives each job that lists the credential the same credentialEnv", () => {
			const result = parse({
				jobs: {
					one: job({ credentials: ["api-key"] }),
					two: job({ credentials: ["api-key", "other"] }),
					three: job(),
				},
				credentials: { "api-key": { env: "API_KEY" } },
			});
			if (!result.ok) throw new Error(result.error);
			const entries = Object.fromEntries(result.jobs.map((item) => [item.name, item.entry]));
			expect(entries.one.credentialEnv).toEqual({ API_KEY: "api-key" });
			expect(entries.two.credentialEnv).toEqual({ API_KEY: "api-key" });
			expect(entries.three).not.toHaveProperty("credentialEnv");
			expect(entries.one.grant).toBe("tools");
			expect(describeCredentials(result.jobs, result.credentials)[0]).toMatchObject({
				name: "api-key",
				env: "API_KEY",
			});
		});

		it.each([
			["1BAD", "1BAD"],
			["DG_X", "DG_X"],
			["dg_x", "dg_x"],
			["Dg_Home", "Dg_Home"],
			["LD_PRELOAD", "LD_PRELOAD"],
			["PATH", "PATH"],
		])("refuses the env name %s and names the variable", (env, shown) => {
			const error = errorOf(withDetails({ a: { env } }));
			expect(error).toContain('credential "a": "env":');
			expect(error).toContain(`"${shown}"`);
		});

		it("refuses env that is not a string", () => {
			expect(errorOf(withDetails({ a: { env: 5 } }))).toBe(
				'credential "a": "env" must be a variable name',
			);
		});

		it("refuses env on a credential with required false and says a bound credential is required", () => {
			expect(errorOf(withDetails({ a: { env: "A_KEY", required: false } }))).toContain(
				"a bound credential is required",
			);
		});

		it("accepts env with required true", () => {
			expect(parse(withDetails({ a: { env: "A_KEY", required: true } })).ok).toBe(true);
		});

		it("refuses two credentials of one job that bind one variable", () => {
			const error = errorOf({
				jobs: { j: job({ credentials: ["a", "b"] }) },
				credentials: { a: { env: "TOKEN" }, b: { env: "TOKEN" } },
			});
			expect(error).toBe('job "j": environment variable "TOKEN" is bound to two credentials');
		});

		it("allows two jobs to bind one variable to different credentials", () => {
			const result = parse({
				jobs: { one: job({ credentials: ["a"] }), two: job({ credentials: ["b"] }) },
				credentials: { a: { env: "TOKEN" }, b: { env: "TOKEN" } },
			});
			expect(result.ok).toBe(true);
		});

		it("refuses credentialEnv as a key of a job", () => {
			expect(
				errorOf({ jobs: { j: job({ credentials: ["a"], credentialEnv: { X: "a" } }) } }),
			).toBe('job "j": the key "credentialEnv" is set by dg');
		});

		it("refuses 17 credential names", () => {
			const names = Array.from({ length: 17 }, (_, i) => `c${i}`);
			const jobs = {
				one: job({ credentials: names.slice(0, 9) }),
				two: job({ credentials: names.slice(8) }),
			};
			expect(errorOf({ jobs })).toBe('a "dg" block can declare 16 credentials at most');
		});

		it("counts a name that two jobs share one time", () => {
			const names = Array.from({ length: 16 }, (_, i) => `c${i}`);
			const jobs = { one: job({ credentials: names }), two: job({ credentials: ["c0"] }) };
			expect(parse({ jobs }).ok).toBe(true);
		});

		it("refuses a credential name that fails the name rule under the source", () => {
			expect(errorOf({ jobs: { a: job({ credentials: ["x".repeat(130)] }) } })).toBe(
				`job "a": "credentials" holds a name that is not valid under the grant: "${"x".repeat(130)}"`,
			);
		});
	});

	describe("limits", () => {
		it("refuses 17 jobs", () => {
			const jobs = Object.fromEntries(
				Array.from({ length: 17 }, (_, i) => [`j${i}`, job()]),
			);
			expect(errorOf({ jobs })).toBe('a "dg" block can declare 16 jobs at most');
		});

		it("refuses 65 argv items", () => {
			const argv = Array.from({ length: 65 }, () => "x");
			expect(errorOf({ jobs: { a: job({ argv }) } })).toBe(
				'job "a": "argv" can hold 64 items at most',
			);
		});

		it("accepts 64 argv items", () => {
			const argv = Array.from({ length: 64 }, () => "x");
			expect(parse({ jobs: { a: job({ argv }) } }).ok).toBe(true);
		});

		it("refuses a string of 1025 characters", () => {
			expect(errorOf({ jobs: { a: job({ argv: ["x".repeat(1025)] }) } })).toBe(
				'a string in the "dg" block is longer than 1024 characters',
			);
		});

		it("accepts a string of 1024 characters", () => {
			expect(parse({ jobs: { a: job({ argv: ["x".repeat(1024)] }) } }).ok).toBe(true);
		});

		it.each(["prompt", "default"])("refuses a meta %s of 201 characters", (key) => {
			const meta = { site: { prompt: "p", [key]: "x".repeat(201) } };
			expect(
				errorOf({
					jobs: { a: job({ credentials: ["c"] }) },
					credentials: { c: { meta } },
				}),
			).toContain("200 characters");
		});

		it("refuses a credential prompt of 201 characters", () => {
			expect(
				errorOf({
					jobs: { a: job({ credentials: ["c"] }) },
					credentials: { c: { prompt: "x".repeat(201) } },
				}),
			).toContain("200 characters");
		});
	});
});

describe("describeCredentials", () => {
	it("gives required true and the name as prompt for a name with no details", () => {
		const result = parse({ jobs: { a: job({ credentials: ["c"] }) } });
		if (!result.ok) throw new Error(result.error);
		expect(describeCredentials(result.jobs, result.credentials)).toEqual([
			{ name: "c", required: true, prompt: "c", meta: {}, jobs: ["a"] },
		]);
	});

	it("lists each job that names a credential and applies the details", () => {
		const result = parse({
			jobs: { a: job({ credentials: ["c"] }), b: job({ credentials: ["c"] }) },
			credentials: { c: { prompt: "Token", required: false } },
		});
		if (!result.ok) throw new Error(result.error);
		expect(describeCredentials(result.jobs, result.credentials)).toEqual([
			{ name: "c", required: false, prompt: "Token", meta: {}, jobs: ["a", "b"] },
		]);
	});
});

describe("declarationHash", () => {
	it("gives 64 hexadecimal characters", () => {
		expect(declarationHash({ jobs: {} })).toMatch(/^[0-9a-f]{64}$/);
	});

	it("does not depend on key order at any level", () => {
		const one = { jobs: { a: { argv: ["x"], continuous: true } }, build: ["b"] };
		const two = { build: ["b"], jobs: { a: { continuous: true, argv: ["x"] } } };
		expect(declarationHash(one)).toBe(declarationHash(two));
	});

	it("changes when a credential detail changes", () => {
		const base = { jobs: {}, credentials: { c: { prompt: "a" } } };
		const changed = { jobs: {}, credentials: { c: { prompt: "b" } } };
		expect(declarationHash(base)).not.toBe(declarationHash(changed));
	});

	it("keeps the order of array items", () => {
		expect(declarationHash({ build: ["a", "b"] })).not.toBe(
			declarationHash({ build: ["b", "a"] }),
		);
	});
});
