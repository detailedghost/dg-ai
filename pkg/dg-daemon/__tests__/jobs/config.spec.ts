import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	countEnabledScheduled,
	DEFAULT_STOP_TIMEOUT_MS,
	JOBS_CONFIG_KEY,
	MAX_STOP_TIMEOUT_MS,
	parseJobEntry,
	parseJobs,
} from "../../src/jobs/config";

const continuous = { argv: ["bot"], cwd: "/srv", continuous: true };
const scheduled = { argv: ["tick"], cwd: "/srv", schedule: "*/5 * * * *" };
const periodic = { argv: ["tick"], cwd: "/srv", every: "15m" };

const failure = (entry: unknown, name = "bot") => {
	const result = parseJobEntry(name, entry);
	if (result.ok) throw new Error("expected the entry to be refused");
	return result.error;
};

describe("jobs/config constants", () => {
	it("names the table key and keeps the stop timeout limits", () => {
		expect(JOBS_CONFIG_KEY).toBe("jobs");
		expect(DEFAULT_STOP_TIMEOUT_MS).toBe(5_000);
		expect(MAX_STOP_TIMEOUT_MS).toBe(240_000);
	});
});

describe("parseJobEntry modes", () => {
	it.each([
		["continuous", continuous],
		["schedule", scheduled],
		["every", periodic],
	])("accepts an entry with only the %s mode", (_mode, entry) => {
		expect(parseJobEntry("bot", entry)).toMatchObject({
			ok: true,
			name: "bot",
			argv: entry.argv,
			cwd: "/srv",
		});
	});

	it("refuses two mode keys", () => {
		expect(failure({ ...continuous, every: "15m" })).toBe(
			'give exactly one of "continuous", "schedule" or "every"',
		);
		expect(failure({ ...scheduled, every: "15m" })).toBe(
			'give exactly one of "continuous", "schedule" or "every"',
		);
	});

	it("refuses an entry with no mode key with the same text", () => {
		expect(failure({ argv: ["bot"], cwd: "/srv" })).toBe(
			'give exactly one of "continuous", "schedule" or "every"',
		);
	});

	it.each([false, "true", 1, null])('refuses "continuous": %p', (value) => {
		expect(failure({ ...continuous, continuous: value })).toBe(
			'"continuous" must be true',
		);
	});

	it("refuses a schedule that the cron parser refuses", () => {
		expect(failure({ ...scheduled, schedule: "not a cron" })).toContain(
			'"schedule"',
		);
		expect(failure({ ...scheduled, schedule: 5 })).toContain('"schedule"');
	});

	it.each(["15", "0m", "m", "15d", 900_000])(
		"refuses an every value that parseEvery refuses: %p",
		(value) => {
			expect(failure({ ...periodic, every: value })).toContain('"every"');
		},
	);
});

describe("parseJobEntry keys", () => {
	it("refuses autostart and names it", () => {
		expect(failure({ ...continuous, autostart: true })).toBe(
			"unknown key(s): autostart",
		);
		expect(failure({ ...continuous, autostart: "yes" })).toBe(
			"unknown key(s): autostart",
		);
	});

	it("refuses each other key and lists them in order", () => {
		expect(failure({ ...continuous, zed: 1, alpha: 2 })).toBe(
			"unknown key(s): zed, alpha",
		);
	});

	it("keeps the declared passEnv, envFile, stopTimeoutMs and grant", () => {
		expect(
			parseJobEntry("bot", {
				...continuous,
				passEnv: ["A", "B", "A"],
				envFile: "/srv/.env",
				stopTimeoutMs: 30_000,
				grant: "bot",
			}),
		).toMatchObject({
			ok: true,
			passEnv: ["A", "B"],
			envFile: "/srv/.env",
			stopTimeoutMs: 30_000,
			grant: "bot",
		});
	});

	it("defaults passEnv to [] and stopTimeoutMs to the default", () => {
		expect(parseJobEntry("bot", continuous)).toMatchObject({
			ok: true,
			passEnv: [],
			stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
		});
	});

	it.each([
		["absent", undefined],
		["relative", "srv"],
		["not a string", 5],
	])("refuses a cwd that is %s", (_label, cwd) => {
		const { cwd: _drop, ...rest } = continuous;
		expect(
			failure({ ...rest, ...(cwd === undefined ? {} : { cwd }) }),
		).toContain('"cwd"');
	});

	it("refuses an empty argv", () => {
		expect(failure({ ...continuous, argv: [] })).toContain('"argv"');
	});

	it("refuses a stopTimeoutMs above the maximum", () => {
		expect(
			failure({ ...continuous, stopTimeoutMs: MAX_STOP_TIMEOUT_MS + 1 }),
		).toContain('"stopTimeoutMs"');
	});
});

describe("parseJobEntry enabled", () => {
	it.each([
		["continuous", continuous],
		["schedule", scheduled],
		["every", periodic],
	])("accepts a boolean enabled with the %s mode", (_mode, entry) => {
		expect(parseJobEntry("bot", { ...entry, enabled: true })).toMatchObject({
			ok: true,
			enabled: true,
		});
		expect(parseJobEntry("bot", { ...entry, enabled: false })).toMatchObject({
			ok: true,
			enabled: false,
		});
	});

	it.each(["yes", 1, null])("refuses enabled %p", (value) => {
		expect(failure({ ...continuous, enabled: value })).toContain('"enabled"');
	});
});

describe("parseJobEntry scheduled-only keys", () => {
	it.each([
		["feed", true],
		["timeoutMs", 1000],
	])("refuses %s on a continuous entry", (key, value) => {
		expect(failure({ ...continuous, [key]: value })).toBe(
			`"${key}" needs "schedule" or "every"`,
		);
	});

	it("refuses notify on a continuous entry", () => {
		expect(failure({ ...continuous, notify: "tick" })).toBe(
			'"notify" needs "schedule" or "every"',
		);
	});

	it.each([
		["schedule", scheduled],
		["every", periodic],
	])("accepts feed, notify and timeoutMs with %s", (_mode, entry) => {
		expect(
			parseJobEntry("bot", { ...entry, feed: true, notify: "n", timeoutMs: 1 }),
		).toMatchObject({ ok: true });
	});

	it("refuses notify without feed true", () => {
		expect(failure({ ...periodic, notify: "n" })).toContain('"notify"');
		expect(failure({ ...periodic, feed: false, notify: "n" })).toContain(
			'"notify"',
		);
	});

	it("refuses an empty or non-string notify", () => {
		expect(failure({ ...periodic, feed: true, notify: "" })).toContain(
			'"notify"',
		);
		expect(failure({ ...periodic, feed: true, notify: 3 })).toContain(
			'"notify"',
		);
	});

	it.each(["yes", 1, null])("refuses a feed that is %p", (value) => {
		expect(failure({ ...periodic, feed: value })).toContain('"feed"');
	});

	it.each([0, -1, 1.5, "10", Number.NaN])(
		"refuses a timeoutMs of %p",
		(value) => {
			expect(failure({ ...periodic, timeoutMs: value })).toContain(
				'"timeoutMs"',
			);
		},
	);

	it("refuses stopTimeoutMs on a scheduled entry", () => {
		expect(failure({ ...periodic, stopTimeoutMs: 1000 })).toContain(
			'"stopTimeoutMs"',
		);
		expect(failure({ ...scheduled, stopTimeoutMs: 1000 })).toContain(
			'"stopTimeoutMs"',
		);
	});
});

describe("parseJobEntry credentials", () => {
	const withGrant = { ...periodic, grant: "bot" };

	it("accepts credential names under a grant", () => {
		expect(
			parseJobEntry("bot", { ...withGrant, credentials: ["token", "key.v2"] }),
		).toMatchObject({ ok: true });
	});

	it("refuses credentials with no grant", () => {
		expect(failure({ ...periodic, credentials: ["token"] })).toBe(
			'"credentials" needs "grant"',
		);
	});

	it("refuses a name that validateCredentialName refuses once joined to the grant", () => {
		expect(failure({ ...withGrant, credentials: ["bad name"] })).toContain(
			'"credentials"',
		);
		expect(failure({ ...withGrant, credentials: [""] })).toContain(
			'"credentials"',
		);
		expect(failure({ ...withGrant, credentials: [5] })).toContain(
			'"credentials"',
		);
	});

	it("refuses a credentials name with an empty, dot or dot-dot segment", () => {
		for (const name of ["../other/secret", ".", "x//y", "x/"]) {
			expect(failure({ ...withGrant, credentials: [name] })).toContain(
				'"credentials"',
			);
		}
	});

	it("refuses a credentials value that is not an array", () => {
		expect(failure({ ...withGrant, credentials: "token" })).toContain(
			'"credentials"',
		);
	});

	it("refuses one name two times", () => {
		expect(failure({ ...withGrant, credentials: ["a", "b", "a"] })).toContain(
			'"credentials"',
		);
	});

	it("refuses two names that differ only in letter case", () => {
		expect(
			failure({ ...withGrant, credentials: ["Token", "token"] }),
		).toContain('"credentials"');
	});

	it("accepts a mixed-case name and keeps it folded to lowercase", () => {
		const parsed = parseJobEntry("bot", {
			...withGrant,
			credentials: ["Token"],
		});
		expect(parsed).toMatchObject({ ok: true });
		expect(parsed.ok && parsed.credentials).toEqual(["token"]);
	});

	it("accepts 16 names and refuses 17", () => {
		const names = (count: number) =>
			Array.from({ length: count }, (_, i) => `n${i}`);
		expect(
			parseJobEntry("bot", { ...withGrant, credentials: names(16) }),
		).toMatchObject({ ok: true });
		expect(failure({ ...withGrant, credentials: names(17) })).toContain(
			'"credentials"',
		);
	});
});

describe("parseJobEntry credentialEnv", () => {
	const bound = {
		...continuous,
		grant: "poll",
		credentials: ["api-key"],
		credentialEnv: { API_KEY: "api-key" },
	};

	it("accepts a binding of a listed credential to a variable", () => {
		expect(parseJobEntry("bot", bound)).toMatchObject({
			ok: true,
			credentialEnv: { API_KEY: "api-key" },
		});
	});

	it("gives an empty credentialEnv for an entry with no binding", () => {
		expect(parseJobEntry("bot", continuous)).toMatchObject({ ok: true, credentialEnv: {} });
	});

	it("refuses a value that is not in the credentials list", () => {
		expect(failure({ ...bound, credentialEnv: { API_KEY: "other" } })).toContain(
			'"API_KEY" to a credential that is not in "credentials"',
		);
	});

	it("refuses credentialEnv on an entry with no grant", () => {
		const { grant: _grant, credentials: _credentials, ...rest } = bound;
		expect(failure(rest)).toBe('"credentialEnv" needs "grant"');
	});

	it("refuses credentialEnv that is not an object", () => {
		expect(failure({ ...bound, credentialEnv: ["API_KEY"] })).toBe(
			'"credentialEnv" must be an object of variable names',
		);
	});

	it.each(["1BAD", "has space", "DG_X", "dg_x", "Dg_Token", "LD_PRELOAD", "node_options", "PATH"])(
		"refuses the variable %p and names it",
		(variable) => {
			const error = failure({ ...bound, credentialEnv: { [variable]: "api-key" } });
			expect(error).toContain(`"credentialEnv": environment variable ${JSON.stringify(variable)}`);
		},
	);

	it("accepts a variable with a DG-like text that does not start with DG_", () => {
		expect(parseJobEntry("bot", { ...bound, credentialEnv: { DGX: "api-key" } }).ok).toBe(true);
	});

	it("lets one credential bind two variables", () => {
		expect(
			parseJobEntry("bot", { ...bound, credentialEnv: { A_ONE: "api-key", A_TWO: "api-key" } }).ok,
		).toBe(true);
	});

	it.each(["pw", "extension", "phone-vault", "db"])(
		"refuses credentialEnv under the reserved prefix %s",
		(grant) => {
			expect(
				failure({ ...continuous, grant, credentials: ["github.com"], credentialEnv: { TOKEN: "github.com" } }),
			).toBe(`"credentialEnv" cannot use the reserved credential prefix "${grant}"`);
		},
	);

	it("still accepts a reserved grant with no credentialEnv", () => {
		expect(parseJobEntry("bot", { ...continuous, grant: "pw", credentials: ["a"] }).ok).toBe(true);
	});

	it("refuses a __proto__ key", () => {
		const entry = JSON.parse(
			'{"argv":["bot"],"cwd":"/srv","continuous":true,"grant":"poll","credentials":["a"],"credentialEnv":{"__proto__":"a"}}',
		);
		expect(failure(entry)).toContain("__proto__");
	});

	it("accepts a variable named constructor", () => {
		expect(
			parseJobEntry("bot", { ...bound, credentialEnv: { constructor: "api-key" } }),
		).toMatchObject({ ok: true, credentialEnv: { constructor: "api-key" } });
	});

	it("refuses a variable name longer than 64 characters", () => {
		expect(
			failure({ ...bound, credentialEnv: { [`A${"B".repeat(64)}`]: "api-key" } }),
		).toContain("longer than 64");
	});

	it("folds the credential letter case as the credentials list does", () => {
		expect(
			parseJobEntry("bot", { ...bound, credentialEnv: { API_KEY: "API-Key" } }),
		).toMatchObject({ ok: true, credentialEnv: { API_KEY: "api-key" } });
	});
});

describe("parseJobEntry name rule", () => {
	it.each(["Bad Name", "", "-lead", "con", "a".repeat(65), "has.dot"])(
		"refuses the job name %p",
		(name) => {
			expect(parseJobEntry(name, continuous)).toMatchObject({
				ok: false,
				name,
			});
		},
	);

	it("holds no copy of the name pattern in its source", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../src/jobs/config.ts"),
			"utf8",
		);
		expect(source).toContain("isJobName");
		expect(source).not.toMatch(/\[a-z0-9\]\[a-z0-9-\]/);
	});

	it("refuses a value that is not an object", () => {
		for (const raw of [1, "x", null, [1]]) {
			expect(failure(raw)).toBe("must be an object");
		}
	});
});

describe("parseJobs", () => {
	it("gives [] when the table is absent", () => {
		expect(parseJobs({})).toEqual([]);
	});

	it("reports a table that is not an object as one invalid row", () => {
		const [row] = parseJobs({ jobs: [1] });
		expect(row).toMatchObject({ ok: false });
	});

	it("reports a bad entry and still parses the good one", () => {
		const rows = parseJobs({
			jobs: { bad: { argv: ["x"], cwd: "/srv" }, good: continuous },
		});
		expect(rows.map((row) => [row.name, row.ok])).toEqual([
			["bad", false],
			["good", true],
		]);
	});

	it("reads the jobs key and ignores a services key", () => {
		expect(parseJobs({ services: { bot: continuous } })).toEqual([]);
	});

	it("keeps a __proto__ name as an own row", () => {
		const jobs = Object.fromEntries([["__proto__", continuous]]);
		expect(parseJobs({ jobs }).map((row) => row.name)).toEqual(["__proto__"]);
	});
});

describe("countEnabledScheduled", () => {
	it("counts only enabled scheduled entries and not continuous or disabled ones", () => {
		const jobs = {
			a: { ...periodic, enabled: true },
			b: { ...scheduled, enabled: true },
			c: { ...periodic },
			d: { ...continuous, enabled: true },
		};

		expect(countEnabledScheduled({ jobs })).toBe(2);
		expect(countEnabledScheduled({})).toBe(0);
	});
});
