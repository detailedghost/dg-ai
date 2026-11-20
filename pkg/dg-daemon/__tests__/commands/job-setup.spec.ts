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

function rigFor(options: RigOptions = {}, extra: Record<string, unknown> = {}): Rig {
	const rig = setupRig((cwd) => ({ x: credentialJob(cwd, extra) }), options);
	rigs.push(rig);
	return rig;
}

const STORED = ["x/api", "x/metrics", "x/errors"].map((name) => ({ name }));
const LOGIN = /Start dg at login/;
const noValue = (text: string) => {
	for (const value of ALL_VALUES) expect(text).not.toContain(value);
};
const never = (question: string) => !question.startsWith("Replace");
const accepted = { x: { kind: "command", prefixAccepted: true } };

describe("job setup at a terminal", () => {
	it("shows the state and the date of each credential and never a value", async () => {
		const rig = rigFor({
			stored: [
				{ name: "x/api", updatedAt: "2026-02-03T00:00:00.000Z" },
				{ name: "x/metrics", meta: { expiresAt: "2001-05-06T00:00:00Z" } },
			],
			grant: "ok",
			answer: never,
			hidden: [VALUE_C],
		});
		rig.seedRegistry(accepted);

		const result = await rig.run(["setup", "x"]);

		expect(result.stderr).toContain("api: stored, updated 2026-02-03");
		expect(result.stderr).toContain("metrics: expired 2001-05-06");
		expect(result.stderr).toContain("errors: missing");
		noValue(everything(result));
	});

	it("asks Replace for a stored credential and changes nothing for the answer n", async () => {
		const rig = rigFor({ stored: STORED, grant: "ok", answer: () => false });
		rig.seedRegistry(accepted);

		const result = await rig.run(["setup", "x"]);

		expect(result.code).toBe(0);
		expect(rig.asked.confirms.filter((question) => question.startsWith("Replace"))).toEqual([
			"Replace api? [y/N]",
			"Replace metrics? [y/N]",
			"Replace errors? [y/N]",
		]);
		expect(rig.calls.set).toEqual([]);
		expect(rig.calls.ensureGrant).toBe(0);
		expect(result.stdout).not.toContain("next:");
	});

	it("stores a replaced value, prints the restart line for a job that runs and never enables or starts", async () => {
		const rig = rigFor({
			stored: STORED,
			grant: "ok",
			answer: (question) => question === "Replace metrics? [y/N]",
			hidden: [VALUE_B],
			running: ["x"],
		});
		rig.seedRegistry(accepted);

		const result = await rig.run(["setup", "x"]);

		expect(result.code).toBe(0);
		expect(rig.calls.set.map((call) => [call.name, call.value])).toEqual([["x/metrics", VALUE_B]]);
		expect(rig.calls.ensureGrant).toBe(1);
		expect(result.stdout).toContain("stored metrics");
		expect(result.stdout).toContain("next: dg job restart x");
		expect(rig.table().x.enabled).toBeUndefined();
		expect(rig.daemon.requests.some((request) => request.startsWith("POST"))).toBe(false);
		noValue(everything(result));
	});

	it("prints no restart line when the job does not run", async () => {
		const rig = rigFor({
			stored: STORED,
			grant: "ok",
			answer: (question) => question === "Replace api? [y/N]",
			hidden: [VALUE_A],
		});
		rig.seedRegistry(accepted);

		const result = await rig.run(["setup", "x"]);

		expect(result.stdout).not.toContain("next:");
	});

	it("prints a restart line for each job with the prefix that runs", async () => {
		const rig = setupRig(
			(cwd) => ({
				a: credentialJob(cwd, { credentials: ["api"], grant: "tools" }),
				b: credentialJob(cwd, { credentials: ["api"], grant: "tools" }),
				c: credentialJob(cwd, { credentials: ["api"], grant: "other" }),
			}),
			{ stored: [{ name: "tools/api" }], grant: "ok", answer: () => true, hidden: [VALUE_A], running: ["b", "a", "c"] },
		);
		rigs.push(rig);
		rig.seedRegistry({ a: { kind: "command", prefixAccepted: true } });

		const result = await rig.run(["setup", "a"]);

		expect(result.stdout).toContain("next: dg job restart a\nnext: dg job restart b");
		expect(result.stdout).not.toContain("restart c");
	});

	it("asks for a missing credential with no Replace question and writes the setup mark", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C] });

		const result = await rig.run(["setup", "x"]);

		expect(result.code).toBe(0);
		expect(rig.asked.confirms.filter((question) => question.startsWith("Replace"))).toEqual([]);
		expect(rig.calls.set).toHaveLength(3);
		expect(rig.registry().x).toEqual({ kind: "command", prefixAccepted: true, setupDone: ["x"] });
	});

	it("asks the adoption question first", async () => {
		const rig = rigFor({ stored: [{ name: "x/other" }], grant: "ok", answer: () => false });

		const result = await rig.run(["setup", "x"]);

		expect(result.code).toBe(1);
		expect(rig.asked.confirms).toEqual(["This job can read these credentials. Continue? [y/N]"]);
		expect(rig.calls.set).toEqual([]);
	});

	it("exits 1 for a job that lists no credential", async () => {
		const rig = setupRig((cwd) => ({ y: { continuous: true, argv: ["x"], cwd } }));
		rigs.push(rig);

		const result = await rig.run(["setup", "y"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job setup: job "y" lists no credential');
		expect(rig.daemon.requests).toEqual([]);
	});

	it("exits 1 for a job that does not exist", async () => {
		const rig = rigFor();

		const result = await rig.run(["setup", "nope"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "nope"');
	});

	it("exits 1 with no terminal, stores nothing and contacts no daemon", async () => {
		const rig = rigFor({ terminal: false });

		const result = await rig.run(["setup", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("run it in a terminal");
		expect(rig.calls.set).toEqual([]);
		expect(rig.daemon.requests).toEqual([]);
		expect(rig.clientPaths).toEqual([]);
	});

	it("has no --setup option", async () => {
		const rig = rigFor();

		const result = await rig.run(["setup", "x", "--setup", "file"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("--setup");
		expect(rig.calls.set).toEqual([]);
	});

	it("stops at a failed set, prints the stored names and writes no setup mark", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C], failSet: "x/errors" });

		const result = await rig.run(["setup", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("stored: api, metrics");
		expect(rig.registry().x?.setupDone).toBeUndefined();
	});
});

describe("job setup --rotate-token", () => {
	it("rotates the token, changes no credential and prints the restart line for a job that runs", async () => {
		const rig = rigFor({ stored: STORED, grant: "ok", running: ["x"] });
		rig.seedRegistry(accepted);

		const result = await rig.run(["setup", "x", "--rotate-token"]);

		expect(result.code).toBe(0);
		expect(rig.calls.rotateGrant).toBe(1);
		expect(rig.calls.set).toEqual([]);
		expect(rig.calls.ensureGrant).toBe(0);
		expect(result.stdout).toContain("next: dg job restart x");
	});

	it("needs no terminal and asks nothing", async () => {
		const rig = rigFor({ terminal: false, grant: "ok" });
		rig.seedRegistry(accepted);

		const result = await rig.run(["setup", "x", "--rotate-token"]);

		expect(result.code).toBe(0);
		expect(rig.asked.confirms).toEqual([]);
		expect(rig.asked.hidden).toEqual([]);
	});

	it("turns the no credential prefix answer of the route into one line", async () => {
		const rig = rigFor({ failRotate: 'job "x" has no credential prefix', grant: "ok" });
		rig.seedRegistry(accepted);

		const result = await rig.run(["setup", "x", "--rotate-token"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job setup: job "x" has no credential prefix');
	});

	it("exits 1 with no terminal and calls rotateGrant zero times when the prefix holds credentials and has no mark", async () => {
		const rig = rigFor({ terminal: false, stored: [{ name: "x/other" }], grant: "ok" });

		const result = await rig.run(["setup", "x", "--rotate-token"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job setup: the prefix x/ holds credentials — run this command in a terminal one time");
		expect(rig.calls.rotateGrant).toBe(0);
	});

	it("asks the adoption question at a terminal before it rotates", async () => {
		const rig = rigFor({ stored: [{ name: "x/other" }], grant: "ok" });

		const result = await rig.run(["setup", "x", "--rotate-token"]);

		expect(result.code).toBe(0);
		expect(rig.asked.confirms).toEqual(["This job can read these credentials. Continue? [y/N]"]);
		expect(rig.calls.rotateGrant).toBe(1);
	});

	it("refuses to rotate when the job has no token", async () => {
		const rig = rigFor({ grant: "missing" });

		const result = await rig.run(["setup", "x", "--rotate-token"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job setup: job "x" has no token to rotate — run dg job enable x');
		expect(rig.calls.rotateGrant).toBe(0);
	});

	it("exits 1 when it is combined with --refresh", async () => {
		const rig = rigFor();

		const result = await rig.run(["setup", "x", "--refresh", "--rotate-token"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job setup: give --refresh alone");
		expect(rig.calls.rotateGrant).toBe(0);
	});
});

describe("job setup client", () => {
	it("builds the client from the paths of the run", async () => {
		const rig = rigFor({ stored: STORED, grant: "ok", answer: () => false });
		rig.seedRegistry(accepted);

		await rig.run(["setup", "x"]);

		expect(rig.clientPaths).toEqual([rig.sb.paths.daemonConfigPath]);
	});
});

describe("job setup output", () => {
	it("starts the login unit question never", async () => {
		const rig = rigFor({ hidden: [VALUE_A, VALUE_B, VALUE_C] });

		await rig.run(["setup", "x"]);

		expect(rig.asked.confirms.some((question) => LOGIN.test(question))).toBe(false);
	});
});
