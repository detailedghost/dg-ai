import { afterEach, describe, expect, it } from "bun:test";
import {
	ALL_VALUES,
	credentialJob,
	everything,
	type Rig,
	type RigOptions,
	setupRig,
	VALUE_A,
	VALUE_B,
	VALUE_C,
} from "./job-setup-kit";

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.close();
});

const SOURCE = { type: "aws-secretsmanager", secretId: "prod/api", region: "us-east-1", profile: "p" };
const SHA = "a".repeat(40);

function rigFor(options: RigOptions, details: Record<string, unknown>): Rig {
	const rig = setupRig(
		(cwd) => ({ x: credentialJob(cwd, { credentials: ["api", "metrics", "errors"], grant: "x" }) }),
		options,
	);
	rigs.push(rig);
	rig.seedRegistry({
		x: {
			kind: "git",
			url: "file:///tmp/x",
			ref: null,
			sha: SHA,
			jobs: ["x"],
			declarationHash: "f".repeat(64),
			credentials: details,
			prefixAccepted: true,
		},
	});
	return rig;
}

const both = { api: { source: SOURCE }, metrics: { source: { ...SOURCE, secretId: "prod/m" } } };
const byId = (argv: string[]) => argv[argv.indexOf("--secret-id") + 1];
const noValue = (text: string) => {
	for (const value of ALL_VALUES) expect(text).not.toContain(value);
};

describe("job setup --refresh", () => {
	it("fetches each credential with a source, stores each, asks nothing and needs no terminal", async () => {
		const rig = rigFor(
			{
				terminal: false,
				stored: [
					{ name: "x/api", meta: { site: "s", expiresAt: "2001-01-01T00:00:00Z", provider: "old" } },
					{ name: "x/metrics" },
					{ name: "x/errors" },
				],
				grant: "ok",
				running: ["x"],
				source: (argv) => ({
					code: 0,
					stdout: `${byId(argv) === "prod/api" ? VALUE_A : VALUE_B}\n`,
					stderr: "",
				}),
			},
			both,
		);

		const result = await rig.run(["setup", "x", "--refresh"]);

		expect(result.code).toBe(0);
		expect(rig.asked.sources).toHaveLength(2);
		expect(rig.asked.hidden).toEqual([]);
		expect(rig.asked.lines).toEqual([]);
		expect(rig.asked.confirms).toEqual([]);
		expect(rig.calls.set.map((call) => [call.name, call.value])).toEqual([
			["x/api", VALUE_A],
			["x/metrics", VALUE_B],
		]);
		expect(rig.calls.set[0].meta).toEqual({
			site: "s",
			provider: "aws-secretsmanager",
			createdBy: "dg job setup",
		});
		expect(result.stdout).toContain("refreshed api, metrics");
		expect(result.stdout).toContain("next: dg job restart x");
		expect(rig.calls.rotateGrant).toBe(0);
		noValue(everything(result));
	});

	it("changes no credential that has no source", async () => {
		const rig = rigFor(
			{ terminal: false, stored: [{ name: "x/errors" }], source: () => ({ code: 0, stdout: VALUE_C, stderr: "" }) },
			{ api: { source: SOURCE } },
		);

		await rig.run(["setup", "x", "--refresh"]);

		expect(rig.calls.set.map((call) => call.name)).toEqual(["x/api"]);
	});

	it("stores nothing when one of two fetches fails and prints the line and the hint", async () => {
		const rig = rigFor(
			{
				terminal: false,
				source: (argv) =>
					byId(argv) === "prod/api"
						? { code: 0, stdout: VALUE_A, stderr: "" }
						: { code: 255, stdout: "", stderr: "Token has expired" },
			},
			both,
		);

		const result = await rig.run(["setup", "x", "--refresh"]);

		expect(result.code).toBe(1);
		expect(rig.calls.set).toEqual([]);
		expect(result.stderr).toContain("job setup: aws failed for metrics: Token has expired");
		expect(result.stderr).toContain("hint: aws sso login --profile p");
		noValue(everything(result));
	});

	it("exits 1 for a job that has no credential with a source", async () => {
		const rig = rigFor({ terminal: false }, {});

		const result = await rig.run(["setup", "x", "--refresh"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'job setup: no credential of job "x" has a source — run dg job setup x to enter a value',
		);
		expect(rig.calls.set).toEqual([]);
	});

	it("exits 1 with the not installed line when aws is missing", async () => {
		const rig = rigFor({ terminal: false }, both);

		const result = await rig.run(["setup", "x", "--refresh"], { which: () => null });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job setup: aws is not installed — it is necessary for api");
		expect(rig.asked.sources).toEqual([]);
	});

	it("is not combined with --rotate-token", async () => {
		const rig = rigFor({ terminal: false }, both);

		const result = await rig.run(["setup", "x", "--rotate-token", "--refresh"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job setup: give --refresh alone");
		expect(rig.asked.sources).toEqual([]);
	});

	it("exits 1 with no terminal and stores nothing when the prefix holds credentials and has no mark", async () => {
		const rig = rigFor(
			{ terminal: false, stored: [{ name: "x/other" }], grant: "ok", source: () => ({ code: 0, stdout: VALUE_A, stderr: "" }) },
			{ api: { source: SOURCE } },
		);
		rig.seedRegistry({
			x: {
				kind: "git",
				url: "file:///tmp/x",
				ref: null,
				sha: SHA,
				jobs: ["x"],
				declarationHash: "f".repeat(64),
				credentials: { api: { source: SOURCE } },
			},
		});

		const result = await rig.run(["setup", "x", "--refresh"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the prefix x/ holds credentials");
		expect(rig.calls.set).toEqual([]);
		expect(rig.asked.sources).toEqual([]);
	});
});
