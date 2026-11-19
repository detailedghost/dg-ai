import { describe, expect, it } from "bun:test";
import {
	DEFAULT_STOP_TIMEOUT_MS,
	MAX_STOP_TIMEOUT_MS,
	parseJobEntry,
	parseJobs,
} from "../../src/jobs/config";
import { ENV_KEY } from "../../src/services/env-file";

const base = { argv: ["bot"], cwd: "/srv", continuous: true };
const declared = (entry: unknown) =>
	parseJobs({ jobs: { bot: entry } });

const PASS_ENV_ERROR =
	'"passEnv" must be an array of environment variable names';
const STOP_ERROR = '"stopTimeoutMs" must be an integer from 1 to 240000';
const GRANT_ERROR = '"grant" must be a credential grant prefix';

describe("ENV_KEY", () => {
	it("is exported and accepts environment variable names only", () => {
		expect(ENV_KEY.test("A_1")).toBe(true);
		expect(ENV_KEY.test("1BAD")).toBe(false);
	});
});

describe("service timeout constants", () => {
	it("exports the default and the maximum", () => {
		expect(DEFAULT_STOP_TIMEOUT_MS).toBe(5_000);
		expect(MAX_STOP_TIMEOUT_MS).toBe(240_000);
	});
});

describe("parseJobs passEnv, stopTimeoutMs and grant", () => {
	it("defaults passEnv to [] and stopTimeoutMs to 5000, with no grant key", () => {
		const [entry] = declared(base);
		expect(entry).toMatchObject({
			ok: true,
			passEnv: [],
			stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
		});
		expect(Object.hasOwn(entry, "grant")).toBe(false);
	});

	it("keeps declared values", () => {
		const [entry] = declared({
			...base,
			passEnv: ["A", "B"],
			stopTimeoutMs: 30_000,
			grant: "bot",
		});
		expect(entry).toMatchObject({
			ok: true,
			passEnv: ["A", "B"],
			stopTimeoutMs: 30_000,
			grant: "bot",
		});
	});

	it("gives each passEnv name once, at the first position", () => {
		const [entry] = declared({ ...base, passEnv: ["B", "A", "B", "A", "C"] });
		expect(entry).toMatchObject({ ok: true, passEnv: ["B", "A", "C"] });
	});

	it.each([
		["a non-array passEnv", { passEnv: "A" }, PASS_ENV_ERROR],
		[
			"a passEnv name with a leading digit",
			{ passEnv: ["1BAD"] },
			PASS_ENV_ERROR,
		],
		["a non-string passEnv name", { passEnv: [1] }, PASS_ENV_ERROR],
		["stopTimeoutMs 0", { stopTimeoutMs: 0 }, STOP_ERROR],
		[
			"stopTimeoutMs 240001",
			{ stopTimeoutMs: MAX_STOP_TIMEOUT_MS + 1 },
			STOP_ERROR,
		],
		["stopTimeoutMs 1.5", { stopTimeoutMs: 1.5 }, STOP_ERROR],
		["a null stopTimeoutMs", { stopTimeoutMs: null }, STOP_ERROR],
		["a string stopTimeoutMs", { stopTimeoutMs: "5000" }, STOP_ERROR],
		["an uppercase grant", { grant: "UPPER" }, GRANT_ERROR],
		["a non-string grant", { grant: 5 }, GRANT_ERROR],
	])(
		"rejects %s with the exact error and leaves other entries valid",
		(_n, extra, error) => {
			const results = parseJobs({
				jobs: { bad: { ...base, ...extra }, good: base },
			});
			expect(results[0]).toEqual({ ok: false, name: "bad", error });
			expect(results[1].ok).toBe(true);
		},
	);

	it.each([1, MAX_STOP_TIMEOUT_MS])(
		"accepts stopTimeoutMs %d",
		(stopTimeoutMs) => {
			expect(declared({ ...base, stopTimeoutMs })[0]).toMatchObject({
				ok: true,
				stopTimeoutMs,
			});
		},
	);
});

describe("parseJobEntry", () => {
	it.each([
		{ ...base, passEnv: ["1BAD"] },
		{ ...base, stopTimeoutMs: 0 },
		{ ...base, grant: "UPPER" },
		{ argv: [], cwd: "/srv", continuous: true },
		"nope",
	])("gives the same result as parseJobs for %p", (entry) => {
		expect(parseJobEntry("bot", entry)).toEqual(declared(entry)[0]);
	});

	it("reports the label rule for an invalid label", () => {
		const result = parseJobEntry("Bad Label", base);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("label must be 1-64");
	});

	it("accepts a valid entry", () => {
		expect(parseJobEntry("bot", base)).toMatchObject({
			ok: true,
			name: "bot",
		});
	});
});
