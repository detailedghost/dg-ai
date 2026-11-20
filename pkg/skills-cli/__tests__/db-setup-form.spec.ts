import { describe, expect, mock, test } from "bun:test";
import type { CredentialMeta, CredentialSummary } from "@dg/common";
import type { DbCredentialClient } from "../src/db/credentials";
import { runSetup, type SetupDeps, type SetupPlan } from "../src/db/setup";
import {
	runSetupForm,
	SecretFormExpiredError,
	type SetupFormClient,
	type SetupFormDeps,
} from "../src/db/setup-form";

const URL_WITH_CODE = "http://127.0.0.1:47823/secret#code=fixture-code-123";
const START = Date.parse("2030-01-01T00:00:00.000Z");
const EXPIRES_AT = new Date(START + 120_000).toISOString();
const META: CredentialMeta = { engine: "postgresql", readOnly: "true" };
const PLAN: SetupPlan = { name: "pg1", meta: META, session: "sess-1" };

function summary(updatedAt: string, name = "db/pg1"): CredentialSummary {
	return { name, meta: {}, updatedAt };
}

type Listings = CredentialSummary[][] | ((sleptMs: number) => CredentialSummary[]);

function formHarness(listings: Listings, overrides: Partial<SetupFormDeps> = {}) {
	let clock = START;
	let polls = 0;
	const stdout: string[] = [];
	const sleeps: number[] = [];
	const intake = mock(async (_name: string, _meta: CredentialMeta) => ({
		url: URL_WITH_CODE,
		expiresAt: EXPIRES_AT,
	}));
	const close = mock(() => {});
	const client: SetupFormClient = {
		intake,
		list: async () =>
			typeof listings === "function"
				? listings(clock - START)
				: (listings[Math.min(polls++, listings.length - 1)] ?? []),
		close,
	};
	const open = mock(async (_url: string) => true);
	const deps: SetupFormDeps = {
		createClient: () => client,
		open,
		now: () => clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
		stdout: (line) => stdout.push(line),
		...overrides,
	};
	return { deps, intake, close, open, stdout, sleeps, advance: (ms: number) => (clock += ms) };
}

describe("runSetupForm", () => {
	test("asks the daemon for a form on db/<name> with the plan meta, opens it, and returns once updatedAt changes", async () => {
		const h = formHarness([
			[summary("t0")],
			[summary("t0")],
			[summary("t0")],
			[summary("t1")],
		]);

		await runSetupForm(PLAN, h.deps);

		expect(h.intake).toHaveBeenCalledWith("db/pg1", META);
		expect(h.open).toHaveBeenCalledWith(URL_WITH_CODE);
		expect(h.sleeps).toHaveLength(3);
		expect(h.close).toHaveBeenCalledTimes(1);
	});

	test("treats a credential that did not exist before as changed once it appears", async () => {
		const h = formHarness([[], [summary("t1")]]);

		await runSetupForm(PLAN, h.deps);

		expect(h.sleeps).toHaveLength(1);
	});

	test("ignores a change to another credential", async () => {
		const h = formHarness([
			[summary("t0"), summary("a", "db/other")],
			[summary("t0"), summary("b", "db/other")],
			[summary("t0"), summary("b", "db/other")],
		]);

		await expect(runSetupForm(PLAN, h.deps)).rejects.toBeInstanceOf(
			SecretFormExpiredError,
		);
	});

	test("matches the stored lowercase name when the connection name has capitals", async () => {
		const h = formHarness([[summary("t0")], [summary("t1")]]);

		await runSetupForm({ ...PLAN, name: "PG1" }, h.deps);

		expect(h.intake).toHaveBeenCalledWith("db/PG1", META);
		expect(h.sleeps).toHaveLength(1);
	});

	test("throws the expiry error once the code has expired without a change, and still closes the client", async () => {
		const h = formHarness(() => [summary("t0")]);

		await expect(runSetupForm(PLAN, h.deps)).rejects.toBeInstanceOf(
			SecretFormExpiredError,
		);

		expect(h.close).toHaveBeenCalledTimes(1);
		expect(h.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(
			120_000,
		);
	});

	test("accepts a submit that lands in the last poll before the code expires", async () => {
		const h = formHarness((sleptMs) => [summary(sleptMs >= 120_000 ? "t1" : "t0")]);

		await runSetupForm(PLAN, h.deps);

		expect(h.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(
			120_000,
		);
	});

	test("prints the link only when the browser could not be opened", async () => {
		const opened = formHarness([[summary("t0")], [summary("t1")]]);
		await runSetupForm(PLAN, opened.deps);
		const failed = formHarness([[summary("t0")], [summary("t1")]], {
			open: async () => false,
		});
		await runSetupForm(PLAN, failed.deps);

		expect(opened.stdout.join("\n")).not.toContain(URL_WITH_CODE);
		expect(failed.stdout.join("\n")).toContain(URL_WITH_CODE);
	});

	test("lets a daemon error through and closes the client", async () => {
		const h = formHarness([[summary("t0")]]);
		h.intake.mockImplementation(async () => {
			throw new Error("daemon refused");
		});

		await expect(runSetupForm(PLAN, h.deps)).rejects.toThrow("daemon refused");

		expect(h.close).toHaveBeenCalledTimes(1);
		expect(h.open).not.toHaveBeenCalled();
	});
});

function setupHarness(form?: SetupDeps["form"]) {
	const stdout: string[] = [];
	const set = mock(async () => {});
	const client = { get: async () => undefined, list: async () => [], set, close: () => {} };
	const runTest = mock(async (_args: string[]) => 0 as number | void);
	const deps: SetupDeps = {
		createCredentialClient: () => client as unknown as DbCredentialClient,
		ensureSession: async (explicit) => explicit ?? "sess-1",
		runTest,
		stdout: (line) => stdout.push(line),
		form,
	};
	return { deps, stdout, set, runTest };
}

const PG_FORM_ARGS = [
	"pg1",
	"--engine",
	"postgresql",
	"--host",
	"127.0.0.1",
	"--port",
	"5433",
	"--database",
	"app",
	"--user",
	"ro",
	"--secret",
	"form",
];

describe("db setup --secret form", () => {
	test("hands the plan to the form, then runs db test and prints the next command", async () => {
		const form = mock(async (_plan: SetupPlan) => {});
		const h = setupHarness(form);

		const code = await runSetup(PG_FORM_ARGS, h.deps);

		expect(code).toBe(0);
		expect(form).toHaveBeenCalledTimes(1);
		expect(form.mock.calls[0]?.[0]).toMatchObject({
			name: "pg1",
			session: "sess-1",
			meta: { engine: "postgresql", host: "127.0.0.1", readOnly: "true" },
		});
		expect(h.set).not.toHaveBeenCalled();
		expect(h.runTest).toHaveBeenCalledWith(["pg1", "--session", "sess-1"]);
		expect(h.stdout.filter((line) => line.startsWith("Next:"))).toEqual([
			"Next: dg-skills db tables pg1",
		]);
	});

	test("on code expiry returns 1, prints the setup command again and runs no db test", async () => {
		const h = setupHarness(async () => {
			throw new SecretFormExpiredError();
		});

		const code = await runSetup(PG_FORM_ARGS, h.deps);

		expect(code).toBe(1);
		expect(h.runTest).not.toHaveBeenCalled();
		expect(h.stdout.some((line) => line.startsWith("Stored"))).toBe(false);
		const again = h.stdout.find((line) => line.includes("dg-skills db setup"));
		expect(again).toBe(`Next: dg-skills db setup ${PG_FORM_ARGS.join(" ")}`);
	});

	test("quotes an argument with a space when it prints the setup command again", async () => {
		const h = setupHarness(async () => {
			throw new SecretFormExpiredError();
		});

		await runSetup([...PG_FORM_ARGS, "--schema", "my schema"], h.deps);

		expect(h.stdout.join("\n")).toContain("--schema 'my schema'");
	});

	test("passes any other form error up", async () => {
		const h = setupHarness(async () => {
			throw new Error("daemon is down");
		});

		await expect(runSetup(PG_FORM_ARGS, h.deps)).rejects.toThrow("daemon is down");
		expect(h.runTest).not.toHaveBeenCalled();
	});

	test("uses the built-in form when none is injected, which needs a running daemon", async () => {
		const h = setupHarness(undefined);

		await expect(runSetup(PG_FORM_ARGS, h.deps)).rejects.toThrow(
			/dg-daemon is not running/,
		);
		expect(h.runTest).not.toHaveBeenCalled();
	});
});
