import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
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
