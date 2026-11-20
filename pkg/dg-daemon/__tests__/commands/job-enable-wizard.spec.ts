import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { CHAT_JOBS_PATH } from "@dg/common";
import { credentialGrantTokenPath, jobStateDir } from "@dg/common/node";
import { allocatePort, spawnServe, stopServe, waitForHealth } from "../utils/daemon-harness";
import { waitUntil } from "./job-cli-helpers";
import { addFixture, makeRepo, runJob, sandbox } from "./job-source-kit";
import {
	credentialJob,
	everything,
	gitRecord,
	noValue,
	type Rig,
	type RigOptions,
	setupFile,
	setupRig,
	streamOf,
	VALUE_A,
	VALUE_B,
	VALUE_C,
} from "./job-setup-kit";

setDefaultTimeout(30_000);

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.close();
});

function rigFor(options: RigOptions = {}, extra: Record<string, unknown> = {}): Rig {
	const rig = setupRig((cwd) => ({ x: credentialJob(cwd, extra) }), options);
	rigs.push(rig);
	return rig;
}

const STORED = ["x/api", "x/metrics", "x/errors"].map((name) => ({ name }));
const LOGIN = /Start dg at login/;

function seedRecord(rig: Rig, credentials: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	rig.seedRegistry(gitRecord(["x"], credentials, extra));
}

const questions = (rig: Rig) => rig.asked.confirms.filter((question) => !LOGIN.test(question));
const started = (rig: Rig) => rig.daemon.requests.includes("POST /jobs/x/start");

describe("job enable wizard at a terminal", () => {
	it("asks for each missing credential, stores them, grants them and starts the job", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C] });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(0);
		expect(rig.asked.hidden).toEqual(["api: ", "metrics: ", "errors: "]);
		expect(rig.calls.set.map((call) => [call.name, call.value])).toEqual([
			["x/api", VALUE_A],
			["x/metrics", VALUE_B],
			["x/errors", VALUE_C],
		]);
		expect(rig.calls.set.every((call) => call.meta?.createdBy === "dg job setup")).toBe(true);
		expect(rig.calls.ensureGrant).toBe(1);
		expect(rig.table().x.enabled).toBe(true);
		expect(started(rig)).toBe(true);
		expect(result.stdout).toContain('enabled job "x"');
		expect(rig.registry().x).toEqual({
			kind: "command",
			prefixAccepted: true,
			setupDone: ["x"],
		});
		noValue(everything(result));
	});

	it("asks nothing the second time and stores nothing", async () => {
		const rig = rigFor({ stored: STORED, grant: "ok" }, { enabled: true });
		seedRecord(rig, {}, { prefixAccepted: true, setupDone: ["x"] });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(0);
		expect(questions(rig)).toEqual([]);
		expect(rig.asked.hidden).toEqual([]);
		expect(rig.asked.lines).toEqual([]);
		expect(rig.calls.set).toEqual([]);
	});

	it("asks for a required credential that is expired and leaves a stored one alone", async () => {
		const rig = rigFor(
			{
				stored: [
					{ name: "x/api", meta: { expiresAt: "2001-01-01T00:00:00Z" } },
					{ name: "x/metrics" },
					{ name: "x/errors" },
				],
				grant: "ok",
				hidden: [VALUE_A],
			},
		);
		seedRecord(rig, {}, { prefixAccepted: true });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(0);
		expect(rig.calls.set.map((call) => call.name)).toEqual(["x/api"]);
	});

	it("asks for an optional credential the first time only", async () => {
		const optional = { api: { required: false }, metrics: { required: false }, errors: { required: false } };
		const first = rigFor({ hidden: ["", VALUE_B, ""] });
		seedRecord(first, optional);

		const one = await first.run(["enable", "x"]);

		expect(one.code).toBe(0);
		expect(first.asked.hidden).toHaveLength(3);
		expect(first.calls.set.map((call) => call.name)).toEqual(["x/metrics"]);

		const again = await first.run(["enable", "x"]);

		expect(again.code).toBe(0);
		expect(first.asked.hidden).toHaveLength(3);
	});

	it("asks again for a required credential after an empty answer", async () => {
		const rig = rigFor({ hidden: ["", VALUE_A, VALUE_B, VALUE_C] });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(0);
		expect(rig.asked.hidden).toHaveLength(4);
		expect(rig.calls.set[0].value).toBe(VALUE_A);
	});

	it("reads one visible line for each meta key and uses the default for an empty line", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C], lines: ["", "us-west"] });
		seedRecord(rig, {
			api: { meta: { site: { prompt: "Site", default: "main" }, region: { prompt: "Region" } } },
		});

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(0);
		expect(rig.asked.lines).toEqual(["Site [main]: ", "Region: "]);
		expect(rig.calls.set[0].meta).toEqual({
			site: "main",
			region: "us-west",
			createdBy: "dg job setup",
		});
	});

	it("runs the wizard for an entry that is enabled already with a required credential missing", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C] }, { enabled: true });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(0);
		expect(rig.calls.set).toHaveLength(3);
	});

	it("asks the login question after the wizard and writes no mark when the wizard fails", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C], failSet: "x/metrics" });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job enable: could not store metrics: the route refused it");
		expect(rig.asked.confirms.some((question) => LOGIN.test(question))).toBe(false);
		expect(rig.config().loginUnitAsked).toBeUndefined();
	});

	it("asks the login question after the credentials are stored", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C] });

		await rig.run(["enable", "x"]);

		expect(rig.asked.confirms.some((question) => LOGIN.test(question))).toBe(true);
		expect(rig.calls.ensureGrant).toBe(1);
		expect(rig.calls.set).toHaveLength(3);
	});
});

describe("job enable wizard with no terminal", () => {
	it("exits 1 with the missing text, stores nothing and starts nothing", async () => {
		const rig = rigFor({ terminal: false });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job enable: credentials missing or expired: api, metrics, errors — run dg job setup x in a terminal, or give --setup",
		);
		expect(rig.calls.set).toEqual([]);
		expect(rig.calls.ensureGrant).toBe(0);
		expect(started(rig)).toBe(false);
		expect(rig.table().x.enabled).toBeUndefined();
	});

	it("names only the required credentials that have no source and no answer", async () => {
		const rig = rigFor({ terminal: false, stored: [{ name: "x/errors" }], grant: "ok" });
		seedRecord(rig, { metrics: { required: false } }, { prefixAccepted: true });

		const result = await rig.run(["enable", "x"]);

		expect(result.stderr).toContain("credentials missing or expired: api —");
	});

	it("takes complete answers from a file, asks nothing and starts the job", async () => {
		const rig = rigFor({ terminal: false });
		const file = setupFile({
			version: 1,
			credentials: {
				api: { value: VALUE_A, meta: { site: "s" } },
				metrics: { value: VALUE_B },
				errors: { value: VALUE_C, expiresAt: "2099-01-01T00:00:00Z" },
			},
		});

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(0);
		expect(rig.asked.hidden).toEqual([]);
		expect(rig.asked.lines).toEqual([]);
		expect(rig.asked.confirms).toEqual([]);
		expect(rig.calls.set.map((call) => call.value)).toEqual([VALUE_A, VALUE_B, VALUE_C]);
		expect(rig.calls.set[0].meta).toEqual({ site: "s", createdBy: "dg job setup" });
		expect(rig.calls.set[2].meta?.expiresAt).toBe("2099-01-01T00:00:00Z");
		expect(rig.calls.ensureGrant).toBe(1);
		expect(started(rig)).toBe(true);
		noValue(everything(result));
	});

	it("uses the default of a declared meta key that the answer leaves out", async () => {
		const rig = rigFor({ terminal: false });
		seedRecord(rig, { api: { meta: { site: { prompt: "Site", default: "main" } } } });
		const file = setupFile({
			version: 1,
			credentials: {
				api: { value: VALUE_A },
				metrics: { value: VALUE_B },
				errors: { value: VALUE_C },
			},
		});

		await rig.run(["enable", "x", "--setup", file]);

		expect(rig.calls.set[0].meta).toEqual({ site: "main", createdBy: "dg job setup" });
	});

	it("accepts skip for an optional credential and keep for a stored one", async () => {
		const rig = rigFor({ terminal: false, stored: [{ name: "x/errors" }], grant: "ok" });
		seedRecord(rig, { metrics: { required: false } }, { prefixAccepted: true });
		const file = setupFile({
			version: 1,
			credentials: { api: { value: VALUE_A }, metrics: { skip: true }, errors: { keep: true } },
		});

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(0);
		expect(rig.calls.set.map((call) => call.name)).toEqual(["x/api"]);
	});

	it.each([
		["skip on a required credential that is missing", { api: { skip: true } }, '"api" is required and missing'],
		["keep on a credential that is missing", { api: { keep: true } }, '"api" is missing'],
		["source true on a credential with no source", { api: { source: true } }, '--setup: "api" has no source'],
		["a source profile on a credential with no source", { api: { source: { profile: "p" } } }, '--setup: "api" has no source'],
		["a name the job does not list", { nope: { skip: true } }, '--setup: "nope" is not a credential of job "x"'],
	])("refuses %s and stores nothing", async (_label, credentials, message) => {
		const rig = rigFor({ terminal: false });
		const file = setupFile({ version: 1, credentials });

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(message);
		expect(rig.calls.set).toEqual([]);
		expect(started(rig)).toBe(false);
	});

	it("refuses --setup with JSON text before it does anything", async () => {
		const rig = rigFor({ terminal: false });

		const result = await rig.run(["enable", "x", "--setup", '{"version":1}']);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--setup takes a file path or -");
		expect(rig.calls.set).toEqual([]);
		expect(rig.daemon.requests).toEqual([]);
	});

	it("refuses a --setup file that other users can read", async () => {
		const rig = rigFor({ terminal: false });
		const file = setupFile({ version: 1, credentials: { api: { value: VALUE_A } } }, 0o644);

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`--setup file ${file} is readable by other users; run chmod 600 on it`);
		expect(rig.calls.set).toEqual([]);
		noValue(everything(result));
	});

	it("reads the answers from stdin for -", async () => {
		const rig = rigFor({ terminal: false });
		const text = JSON.stringify({
			version: 1,
			credentials: {
				api: { value: VALUE_A },
				metrics: { value: VALUE_B },
				errors: { value: VALUE_C },
			},
		});

		const result = await rig.run(["enable", "x", "--setup", "-"], {
			stdin: () => new Response(text).body as ReadableStream<Uint8Array>,
		});

		expect(result.code).toBe(0);
		expect(rig.calls.set).toHaveLength(3);
	});

	it("refuses --setup for a job that lists no credential", async () => {
		const rig = setupRig((cwd) => ({ y: { continuous: true, argv: ["x"], cwd } }), { terminal: false });
		rigs.push(rig);
		const file = setupFile({ version: 1 });

		const result = await rig.run(["enable", "y", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job enable: job "y" lists no credential');
	});
});

describe("job enable adoption", () => {
	it("exits 1 with no terminal when the prefix holds credentials and no mark exists", async () => {
		const rig = rigFor({ terminal: false, stored: [{ name: "x/other" }], grant: "ok" });
		const file = setupFile({
			version: 1,
			credentials: { api: { value: VALUE_A }, metrics: { value: VALUE_B }, errors: { value: VALUE_C } },
		});

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job enable: the prefix x/ holds credentials — run this command in a terminal one time",
		);
		expect(rig.calls.set).toEqual([]);
	});

	it("asks at a terminal, writes the mark on y, and a later run with no terminal passes", async () => {
		const rig = rigFor({ stored: STORED, grant: "ok" });

		const first = await rig.run(["enable", "x"]);

		expect(first.code).toBe(0);
		expect(rig.asked.confirms).toContain("This job can read these credentials. Continue? [y/N]");
		expect(first.stderr).toContain("credentials below x/: x/api, x/metrics, x/errors");
		expect(rig.registry().x.prefixAccepted).toBe(true);

		const later = await rig.run(["enable", "x"], { isTerminal: () => false });

		expect(later.code).toBe(0);
	});

	it("stores nothing and writes no mark after the answer n", async () => {
		const rig = rigFor({
			stored: [{ name: "x/other" }],
			grant: "ok",
			answer: () => false,
			hidden: [VALUE_A, VALUE_B, VALUE_C],
		});

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job enable: declined; nothing was stored");
		expect(rig.calls.set).toEqual([]);
		expect(rig.registry().x).toBeUndefined();
	});

	it("has no --yes option", async () => {
		const rig = rigFor({ stored: [{ name: "x/other" }], grant: "ok" });

		const result = await rig.run(["enable", "x", "--yes"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("--yes");
	});

	it("does not ask when the grant is missing and nothing is stored", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C] });

		await rig.run(["enable", "x"]);

		expect(questions(rig)).toEqual([]);
	});

	it("passes the second job of one source with no terminal after the first ran at a terminal", async () => {
		const rig = setupRig(
			(cwd) => ({
				a: credentialJob(cwd, { credentials: ["api"], grant: "x" }),
				b: credentialJob(cwd, { credentials: ["api"], grant: "x" }),
			}),
			{ hidden: [VALUE_A] },
		);
		rigs.push(rig);
		rig.seedRegistry(gitRecord(["a", "b"], {}));

		const first = await rig.run(["enable", "a"]);
		const second = await rig.run(["enable", "b"], { isTerminal: () => false });

		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(rig.calls.set).toHaveLength(1);
		expect(rig.registry().x.setupDone).toEqual(["a", "b"]);
		expect(rig.registry().x.prefixAccepted).toBe(true);
	});
});

describe("job enable store failures", () => {
	it("stops at a failed set, prints the stored names, does not enable and exits 1", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C], failSet: "x/metrics" });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("stored: api");
		expect(result.stderr).toContain("could not store metrics");
		expect(rig.calls.set.map((call) => call.name)).toEqual(["x/api"]);
		expect(rig.table().x.enabled).toBeUndefined();
		expect(started(rig)).toBe(false);
		expect(rig.registry().x?.setupDone).toBeUndefined();
		noValue(everything(result));
	});

	it("keeps the mark of the first store after a failed set", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C], failSet: "x/metrics" });

		await rig.run(["enable", "x"]);

		expect(rig.registry().x).toEqual({ kind: "command", prefixAccepted: true });
	});

	it("prints the stored names, writes no setup mark and does not enable when ensureGrant fails; a second run stores nothing and asks for the grant again", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C], failGrant: true });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("stored: api, metrics, errors");
		expect(rig.table().x.enabled).toBeUndefined();
		expect(rig.registry().x?.setupDone).toBeUndefined();
		expect(started(rig)).toBe(false);

		const again = await rig.run(["enable", "x"]);

		expect(again.code).toBe(1);
		expect(rig.calls.set).toHaveLength(3);
		expect(rig.calls.ensureGrant).toBe(2);
	});

	it("collects each value before the first set: a bad meta of the second credential stores nothing", async () => {
		const rig = rigFor({ terminal: false });
		const file = setupFile({
			version: 1,
			credentials: {
				api: { value: VALUE_A },
				metrics: { value: VALUE_B, expiresAt: "not a date" },
				errors: { value: VALUE_C },
			},
		});

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("metrics: credential meta.expiresAt must be an ISO 8601 timestamp");
		expect(rig.calls.set).toEqual([]);
		noValue(everything(result));
	});

	it("refuses a meta key that looks like a secret and stores nothing", async () => {
		const rig = rigFor({ terminal: false });
		const file = setupFile({
			version: 1,
			credentials: {
				api: { value: VALUE_A, meta: { password: "x" } },
				metrics: { value: VALUE_B },
				errors: { value: VALUE_C },
			},
		});

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("api: credential meta.password looks secret; store secrets only as the credential value");
		expect(rig.calls.set).toEqual([]);
	});
});

describe("job enable of a scheduled job", () => {
	it("stores the value, sets enabled and prints the next run", async () => {
		const rig = setupRig(
			(cwd) => ({
				s: { every: "15m", argv: ["tool"], cwd, credentials: ["api"], grant: "s" },
			}),
			{ terminal: false, rows: { s: { nextRunAt: "2030-05-06T07:08:09.000Z" } } },
		);
		rigs.push(rig);
		const file = setupFile({ version: 1, credentials: { api: { value: VALUE_A } } });

		const result = await rig.run(["enable", "s", "--setup", file]);

		expect(result.code).toBe(0);
		expect(rig.calls.set.map((call) => call.name)).toEqual(["s/api"]);
		expect(rig.table().s.enabled).toBe(true);
		expect(result.stdout).toContain("next 2030-05-06T07:08:09.000Z");
		expect(rig.daemon.requests).toContain(`GET ${CHAT_JOBS_PATH}`);
	});
});

describe("job enable with a daemon that does not answer", () => {
	it("writes nothing to the entry", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C] });
		rig.daemon.stop();

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('does not answer, so the state of job "x" is unknown');
		expect(rig.table().x.enabled).toBeUndefined();
		expect(rig.calls.set).toEqual([]);
	});
});

const AWS_SOURCE = {
	type: "aws-secretsmanager",
	secretId: "prod/api",
	region: "us-east-1",
	profile: "p",
};
const awsArgv = (profile: string | undefined) => [
	"secretsmanager",
	"get-secret-value",
	"--secret-id",
	"prod/api",
	"--region",
	"us-east-1",
	...(profile === undefined ? [] : ["--profile", profile]),
	"--query",
	"SecretString",
	"--output",
	"text",
];
const fetched = (stdout = `${VALUE_A}\n`) => () => ({ code: 0, stdout, stderr: "" });

describe("job enable with a credential source", () => {
	const only = { credentials: ["api"] };

	it("fetches a missing credential with no question and stores it with the provider", async () => {
		const rig = rigFor({ source: fetched() }, only);
		seedRecord(rig, { api: { source: AWS_SOURCE } });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(0);
		expect(rig.asked.sources).toHaveLength(1);
		expect(rig.asked.sources[0].argv.slice(1)).toEqual(awsArgv("p"));
		expect(rig.asked.hidden).toEqual([]);
		expect(questions(rig)).toEqual([]);
		expect(result.stderr).toContain("fetching api from AWS Secrets Manager");
		expect(rig.calls.set).toEqual([
			{
				name: "x/api",
				value: VALUE_A,
				meta: { createdBy: "dg job setup", provider: "aws-secretsmanager" },
			},
		]);
		noValue(everything(result));
	});

	it("leaves out --profile when the source has none and gives the env of the caller", async () => {
		const rig = rigFor({ source: fetched() }, only);
		seedRecord(rig, { api: { source: { ...AWS_SOURCE, profile: undefined } } });

		await rig.run(["enable", "x"]);

		expect(rig.asked.sources[0].argv).not.toContain("--profile");
		expect(rig.asked.sources[0].env.PATH).toBe(process.env.PATH);
	});

	it("does not fetch again at the second enable", async () => {
		const rig = rigFor({ source: fetched() }, only);
		seedRecord(rig, { api: { source: AWS_SOURCE } });
		await rig.run(["enable", "x"]);

		const again = await rig.run(["enable", "x"]);

		expect(again.code).toBe(0);
		expect(rig.asked.sources).toHaveLength(1);
		expect(rig.calls.set).toHaveLength(1);
	});

	it("takes the key from a JSON secret", async () => {
		const rig = rigFor({ source: fetched(`{"K":"${VALUE_A}","L":"${VALUE_B}"}`) }, only);
		seedRecord(rig, { api: { source: { ...AWS_SOURCE, key: "K" } } });

		await rig.run(["enable", "x"]);

		expect(rig.calls.set[0].value).toBe(VALUE_A);
	});

	it("exits 1 with the key line for a JSON secret without the key and prints no part of it", async () => {
		const rig = rigFor({ source: fetched(`{"L":"${VALUE_B}"}`), terminal: false }, only);
		seedRecord(rig, { api: { source: { ...AWS_SOURCE, key: "K" } } });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job setup: the secret has no key "K"');
		expect(rig.calls.set).toEqual([]);
		noValue(everything(result));
	});

	it.each([
		["None", "None\n", "job setup: the secret of api has no text value"],
		["empty", "", "job setup: the secret of api has no text value"],
	])("exits 1 for stdout that is %s", async (_label, stdout, line) => {
		const rig = rigFor({ source: fetched(stdout), terminal: false }, only);
		seedRecord(rig, { api: { source: AWS_SOURCE } });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(line);
	});

	it("exits 1 with the fixed line when a key is given and stdout is not JSON", async () => {
		const rig = rigFor({ source: fetched(VALUE_A), terminal: false }, only);
		seedRecord(rig, { api: { source: { ...AWS_SOURCE, key: "K" } } });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job setup: the secret of api is not JSON");
		noValue(everything(result));
	});

	it("exits 1 with the failure line and the hint when aws fails and there is no terminal", async () => {
		const rig = rigFor(
			{ source: () => ({ code: 255, stdout: "", stderr: "Token has expired\nmore" }), terminal: false },
			only,
		);
		seedRecord(rig, { api: { source: AWS_SOURCE } });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job setup: aws failed for api: Token has expired");
		expect(result.stderr).toContain("hint: aws sso login --profile p");
		expect(result.stderr).not.toContain("more");
		expect(rig.calls.set).toEqual([]);
	});

	it("gives the hint with no profile when the source has none", async () => {
		const rig = rigFor(
			{ source: () => ({ code: 1, stdout: "", stderr: "denied" }), terminal: false },
			only,
		);
		seedRecord(rig, { api: { source: { ...AWS_SOURCE, profile: undefined } } });

		const result = await rig.run(["enable", "x"]);

		expect(result.stderr).toContain("hint: aws sso login");
		expect(result.stderr).not.toContain("--profile");
	});

	it("exits 1 with the not installed line and starts no process when aws is missing", async () => {
		const rig = rigFor({ terminal: false }, only);
		seedRecord(rig, { api: { source: AWS_SOURCE } });

		const result = await rig.run(["enable", "x"], { which: () => null });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job setup: aws is not installed — it is necessary for api");
		expect(rig.asked.sources).toEqual([]);
	});

	it("reads the value by hand after a failed fetch and the answer y, with no provider", async () => {
		const rig = rigFor(
			{ source: () => ({ code: 1, stdout: "", stderr: "denied" }), hidden: [VALUE_B] },
			only,
		);
		seedRecord(rig, { api: { source: AWS_SOURCE } });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(0);
		expect(rig.asked.confirms).toContain("Enter api by hand? [y/N]");
		expect(rig.calls.set[0].value).toBe(VALUE_B);
		expect(rig.calls.set[0].meta?.provider).toBeUndefined();
	});

	it("stops with nothing stored after a failed fetch and the answer n", async () => {
		const rig = rigFor(
			{
				source: () => ({ code: 1, stdout: "", stderr: "denied" }),
				answer: (question) => !question.includes("by hand"),
			},
			only,
		);
		seedRecord(rig, { api: { source: AWS_SOURCE } });

		const result = await rig.run(["enable", "x"]);

		expect(result.code).toBe(1);
		expect(rig.calls.set).toEqual([]);
		expect(rig.asked.hidden).toEqual([]);
		expect(rig.table().x.enabled).toBeUndefined();
	});

	it("fetches for an answer source true and replaces the profile for source { profile }", async () => {
		const rig = rigFor({ terminal: false, source: fetched() }, { credentials: ["api", "metrics"] });
		seedRecord(rig, { api: { source: AWS_SOURCE }, metrics: { source: AWS_SOURCE } });
		const file = setupFile({
			version: 1,
			credentials: { api: { source: true }, metrics: { source: { profile: "other" } } },
		});

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(0);
		expect(rig.asked.sources.map((call) => call.argv.slice(1))).toEqual([
			awsArgv("p"),
			awsArgv("other"),
		]);
	});

	it("stores a value answer for a credential with a source and starts no fetch", async () => {
		const rig = rigFor({ terminal: false }, only);
		seedRecord(rig, { api: { source: AWS_SOURCE } });
		const file = setupFile({ version: 1, credentials: { api: { value: VALUE_B } } });

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(0);
		expect(rig.asked.sources).toEqual([]);
		expect(rig.calls.set[0].value).toBe(VALUE_B);
		expect(rig.calls.set[0].meta?.provider).toBeUndefined();
	});

	it("refuses a profile that starts with a dash and starts no process", async () => {
		const rig = rigFor({ terminal: false }, only);
		seedRecord(rig, { api: { source: AWS_SOURCE } });
		const file = setupFile({ version: 1, credentials: { api: { source: { profile: "-x" } } } });

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('--setup: the "profile" for "api" is not valid');
		expect(rig.asked.sources).toEqual([]);
		expect(rig.calls.set).toEqual([]);
	});
});

describe("job enable --setup input", () => {
	const complete = {
		version: 1,
		credentials: { api: { value: VALUE_A }, metrics: { value: VALUE_B }, errors: { value: VALUE_C } },
	};

	it("refuses a link to a file that other users can read and stores nothing", async () => {
		const rig = rigFor({ terminal: false });
		const target = setupFile(complete, 0o644);
		const link = `${target}.link`;
		symlinkSync(target, link);

		const result = await rig.run(["enable", "x", "--setup", link]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("readable by other users");
		expect(rig.calls.set).toEqual([]);
	});

	it("takes a link to a file that only the owner can read", async () => {
		const rig = rigFor({ terminal: false });
		const target = setupFile(complete);
		const link = `${target}.link`;
		symlinkSync(target, link);

		const result = await rig.run(["enable", "x", "--setup", link]);

		expect(result.code).toBe(0);
	});

	it("refuses a file above 128 KiB and stores nothing", async () => {
		const rig = rigFor({ terminal: false });
		const file = setupFile(`{"version":1,"pad":"${"x".repeat(131072)}"}`);

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--setup input is larger than 128 KiB");
		expect(rig.calls.set).toEqual([]);
	});

	it("refuses stdin above 128 KiB and stores nothing", async () => {
		const rig = rigFor({ terminal: false });

		const result = await rig.run(["enable", "x", "--setup", "-"], {
			stdin: streamOf(`{"version":1,"pad":"${"x".repeat(131072)}"}`),
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--setup input is larger than 128 KiB");
		expect(rig.calls.set).toEqual([]);
	});

	it("refuses a path that does not exist without echoing the file", async () => {
		const rig = rigFor({ terminal: false });

		const result = await rig.run(["enable", "x", "--setup", "/nonexistent/answers.json"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--setup: cannot read /nonexistent/answers.json");
	});

	it("refuses text that is not JSON with a fixed line", async () => {
		const rig = rigFor({ terminal: false });
		const file = setupFile(`not json ${VALUE_A}`);

		const result = await rig.run(["enable", "x", "--setup", file]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--setup is not valid JSON");
		noValue(everything(result));
	});
});

const READ_SCRIPT = {
	content: `#!${process.execPath}
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
(async () => {
	const prefix = process.env.DG_CREDENTIAL_GRANT_PREFIX;
	const token = readFileSync(process.env.DG_CREDENTIAL_GRANT_FILE, "utf8").trim();
	const response = await fetch(process.env.DG_DAEMON_URL + "/service-api/v1/credentials", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Dg-Grant-Prefix": prefix,
			"X-Dg-Grant-Token": token,
		},
		body: JSON.stringify({ operation: "get", name: prefix + "/token" }),
	});
	const body = await response.json();
	writeFileSync(
		join(process.env.DG_SERVICE_STATE_DIR, process.env.DG_SERVICE_LABEL + ".got"),
		createHash("sha256").update(body.value.value).digest("hex"),
	);
	setTimeout(() => {}, 600000);
})();
`,
	executable: true as const,
};

describe("job enable wizard against a live daemon", () => {
	const box = sandbox(["tool", "sh"]);
	const procs: ReturnType<typeof spawnServe>[] = [];
	afterEach(async () => {
		for (const proc of procs.splice(0)) await stopServe(proc).catch(() => {});
		box.cleanup();
	});

	async function live() {
		const sb = box.create();
		const port = allocatePort();
		procs.push(spawnServe(sb.dgHome, port));
		await waitForHealth(port, 8000);
		return sb;
	}

	const block = (...names: string[]) => ({
		jobs: Object.fromEntries(
			names.map((name) => [
				name,
				{ argv: ["./bin/read"], continuous: true, credentials: ["token"] },
			]),
		),
		credentials: { token: { prompt: "Token" } },
	});

	it("starts a repository job with no terminal and no question, and the job reads the credential through the service API", async () => {
		const sb = await live();
		await addFixture(sb, makeRepo({ dg: block("bot"), files: { "bin/read": READ_SCRIPT } }));
		const file = setupFile({ version: 1, credentials: { token: { value: VALUE_A } } });

		const result = await runJob(["enable", "bot", "--setup", file], {
			...sb.deps(),
			isTerminal: () => false,
			confirm: async () => {
				throw new Error("unexpected question");
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('enabled job "bot"');
		expect(result.stdout).toMatch(/bot +running/);
		noValue(everything(result));
		const got = join(jobStateDir(sb.paths, "bot"), "bot.got");
		await waitUntil(() => existsSync(got));
		expect(readFileSync(got, "utf8")).toBe(createHash("sha256").update(VALUE_A).digest("hex"));
	});

	it("keeps the bytes of the token file when the second job of the source is enabled", async () => {
		const sb = await live();
		await addFixture(sb, makeRepo({ dg: block("a", "b"), files: { "bin/read": READ_SCRIPT } }));
		const offline = { ...sb.deps(), isTerminal: () => false };
		const first = await runJob(
			["enable", "a", "--setup", setupFile({ version: 1, credentials: { token: { value: VALUE_A } } })],
			offline,
		);
		const tokenFile = credentialGrantTokenPath(sb.paths, "tools");
		const before = readFileSync(tokenFile);

		const second = await runJob(
			["enable", "b", "--setup", setupFile({ version: 1, credentials: { token: { keep: true } } })],
			offline,
		);

		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(readFileSync(tokenFile).equals(before)).toBe(true);
	});

	it("rotates the token file at setup --rotate-token and prints a restart line", async () => {
		const sb = await live();
		await addFixture(sb, makeRepo({ dg: block("bot"), files: { "bin/read": READ_SCRIPT } }));
		const offline = { ...sb.deps(), isTerminal: () => false };
		await runJob(
			["enable", "bot", "--setup", setupFile({ version: 1, credentials: { token: { value: VALUE_A } } })],
			offline,
		);
		const tokenFile = credentialGrantTokenPath(sb.paths, "tools");
		const before = readFileSync(tokenFile);

		const result = await runJob(["setup", "bot", "--rotate-token"], offline);

		expect(result.code).toBe(0);
		expect(readFileSync(tokenFile).equals(before)).toBe(false);
		expect(result.stdout).toContain("next: dg job restart bot");
		noValue(everything(result));
	});

	it("stores a fetched value through the real route and keeps it for the next enable", async () => {
		const sb = await live();
		await addFixture(
			sb,
			makeRepo({
				dg: {
					jobs: { bot: { argv: ["./bin/read"], continuous: true, credentials: ["token"] } },
					credentials: {
						token: { prompt: "Token", source: { type: "aws-secretsmanager", secretId: "p/t", region: "us-east-1" } },
					},
				},
				files: { "bin/read": READ_SCRIPT },
			}),
		);
		let fetches = 0;
		const deps = {
			...sb.deps(),
			isTerminal: () => false,
			which: (name: string) => (name === "aws" ? "/fake/aws" : sb.tools.which(name)),
			runSource: async () => {
				fetches++;
				return { code: 0, stdout: `${VALUE_C}\n`, stderr: "" };
			},
		};

		const first = await runJob(["enable", "bot"], deps);
		await runJob(["disable", "bot"], deps);
		const second = await runJob(["enable", "bot"], deps);

		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(fetches).toBe(1);
		const got = join(jobStateDir(sb.paths, "bot"), "bot.got");
		await waitUntil(() => existsSync(got));
		expect(readFileSync(got, "utf8")).toBe(createHash("sha256").update(VALUE_C).digest("hex"));
		noValue(everything(first));
	});
});
