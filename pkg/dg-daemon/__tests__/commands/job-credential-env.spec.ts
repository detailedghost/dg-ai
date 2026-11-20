import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { freshTempDir } from "../utils/daemon-harness";
import {
	addFixture,
	changeBlock,
	fileUrl,
	jobDeclaration,
	makeFolder,
	makeRepo,
	makeScript,
	QUICK_SCRIPT,
	readConfig,
	readRegistry,
	RUN_SCRIPT,
	runJob,
	type Sandbox,
	sandbox,
	withBun,
} from "./job-source-kit";

const box = sandbox(["tool", "sh"]);
let sb: Sandbox;
afterEach(() => box.cleanup());

const FILES = { "bin/run": RUN_SCRIPT, "bin/quick": QUICK_SCRIPT };
const VALUE = "tok-alpha-91f3c2d8";
const CMD = [process.execPath, "-e", "1"];

const add = (args: string[]) => runJob(["add", ...args], withBun(sb));
const update = (args: string[]) => runJob(["update", ...args], withBun(sb));

const refused = async (args: string[], ...texts: string[]) => {
	const result = await add(args);
	expect(result.code).toBe(1);
	for (const text of texts) expect(result.stderr).toContain(text);
	return result;
};

const withBlock = (details: Record<string, unknown> = { "api-key": { env: "API_KEY" } }) => ({
	jobs: {
		bot: { argv: ["./bin/run"], continuous: true, credentials: Object.keys(details) },
	},
	credentials: details,
});

describe("job add --credential <name>=<NAME> of a file", () => {
	it("writes credentials, grant and credentialEnv", async () => {
		sb = box.create();

		const result = await add([
			makeScript("poll.ts"),
			"--every",
			"15m",
			"--credential",
			"api-key=API_KEY",
		]);

		expect(result.code).toBe(0);
		const entry = readConfig(sb).jobs.poll;
		expect(entry.credentials).toEqual(["api-key"]);
		expect(entry.grant).toBe("poll");
		expect(entry.credentialEnv).toEqual({ API_KEY: "api-key" });
	});

	it("lists the credential only, with no credentialEnv, for a name with no =", async () => {
		sb = box.create();

		await add([makeScript("poll.ts"), "--every", "15m", "--credential", "api-key"]);

		const entry = readConfig(sb).jobs.poll;
		expect(entry.credentials).toEqual(["api-key"]);
		expect(entry).not.toHaveProperty("credentialEnv");
	});

	it("binds two credentials to two variables", async () => {
		sb = box.create();

		await add([
			makeScript("poll.ts"),
			"--every",
			"15m",
			"--credential",
			"one=ONE_VAR",
			"--credential",
			"two=TWO_VAR",
		]);

		expect(readConfig(sb).jobs.poll.credentialEnv).toEqual({ ONE_VAR: "one", TWO_VAR: "two" });
	});

	const RULE = "--credential: the text after = must be a variable name such as API_KEY";

	it.each(["1BAD", "sk-live-91f3c2d8", "has space", "A".repeat(65), ""])(
		"refuses the text %p after = without echoing it",
		async (text) => {
			sb = box.create();

			const result = await refused(
				[makeScript("poll.ts"), "--every", "15m", "--credential", `k=${text}`],
				RULE,
			);

			if (text !== "") expect(result.stderr).not.toContain(text);
			expect(readConfig(sb).jobs).toEqual({});
		},
	);

	it("binds a variable named constructor", async () => {
		sb = box.create();

		await add([makeScript("poll.ts"), "--every", "15m", "--credential", "k=constructor"]);

		expect(readConfig(sb).jobs.poll.credentialEnv).toEqual({ constructor: "k" });
	});

	it("binds a variable named toString to two credentials only once", async () => {
		sb = box.create();

		await refused(
			[makeScript("poll.ts"), "--every", "15m", "--credential", "a=toString", "--credential", "b=toString"],
			"toString",
			"two credentials",
		);
	});

	it.each([
		["DG_X", "DG_X"],
		["dg_x", "dg_x"],
		["LD_PRELOAD", "LD_PRELOAD"],
		["NPM_CONFIG_X", "NPM_CONFIG_X"],
	])("exits 1, names the variable and writes nothing for %s", async (variable, shown) => {
		sb = box.create();

		await refused(
			[makeScript("poll.ts"), "--every", "15m", "--credential", `k=${variable}`],
			shown,
		);

		expect(readConfig(sb).jobs).toEqual({});
		expect(existsSync(sb.paths.jobSourcesPath)).toBe(false);
	});

	it("exits 1 and names the variable when two credentials bind one name", async () => {
		sb = box.create();

		await refused(
			[
				makeScript("poll.ts"),
				"--every",
				"15m",
				"--credential",
				"one=TOKEN",
				"--credential",
				"two=TOKEN",
			],
			"TOKEN",
			"two credentials",
		);

		expect(readConfig(sb).jobs).toEqual({});
	});

	it("never prints a stored value", async () => {
		sb = box.create();

		const result = await add([
			makeScript("poll.ts"),
			"--every",
			"15m",
			"--credential",
			"api-key=API_KEY",
		]);

		expect(result.stdout + result.stderr).not.toContain(VALUE);
	});
});

describe("job add --credential <name>=<NAME> of a command", () => {
	it("writes credentialEnv on a continuous command job", async () => {
		sb = box.create();
		const cwd = freshTempDir("job-cwd");

		const result = await add([
			"--name",
			"bot",
			"--cwd",
			cwd,
			"--continuous",
			"--credential",
			"api-key=API_KEY",
			"--",
			...CMD,
		]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.bot).toMatchObject({
			credentials: ["api-key"],
			grant: "bot",
			credentialEnv: { API_KEY: "api-key" },
		});
	});

	it("writes credentialEnv on a scheduled command job", async () => {
		sb = box.create();
		const cwd = freshTempDir("job-cwd");

		const result = await add([
			"--name",
			"tick",
			"--cwd",
			cwd,
			"--every",
			"15m",
			"--credential",
			"api-key=API_KEY",
			"--",
			...CMD,
		]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.tick).toMatchObject({
			every: "15m",
			credentialEnv: { API_KEY: "api-key" },
		});
	});

	it("refuses a reserved loader variable on a command job", async () => {
		sb = box.create();
		const cwd = freshTempDir("job-cwd");

		await refused(
			["--name", "bot", "--cwd", cwd, "--continuous", "--credential", "k=NODE_OPTIONS", "--", ...CMD],
			"NODE_OPTIONS",
		);

		expect(readConfig(sb).jobs).toEqual({});
	});
});

describe("job add of a source with --credential <name>=<NAME>", () => {
	it("exits 1 with the repository text for a URL", async () => {
		sb = box.create();
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });

		const result = await runJob(
			["add", fileUrl(repo), "--name", "tools", "--yes", "--credential", "k=NAME"],
			sb.deps(),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job add: the repository declares this in its "dg" block');
	});

	it("exits 1 with the folder text for a folder", async () => {
		sb = box.create();
		const dir = makeFolder({ dg: jobDeclaration("bot"), files: FILES });

		await refused([dir, "--credential", "k=NAME"], 'job add: the folder declares this in its "dg" block');
	});
});

describe("a dg block with env on a credential", () => {
	it("gives each job that lists the credential the same credentialEnv and shows → env on the request line", async () => {
		sb = box.create();
		const repo = makeRepo({ dg: withBlock(), files: FILES });

		const result = await runJob(["add", fileUrl(repo), "--name", "tools", "--yes"], sb.deps());

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.bot).toMatchObject({
			credentials: ["api-key"],
			grant: "tools",
			credentialEnv: { API_KEY: "api-key" },
		});
		const line = result.stdout.split("\n").find((text) => text.startsWith("credential api-key:"));
		expect(line).toContain("→ env API_KEY");
		expect(readRegistry(sb).tools.credentials).toEqual({ "api-key": { env: "API_KEY" } });
	});

	it("does the same for a folder", async () => {
		sb = box.create();
		const dir = makeFolder({ dg: withBlock(), files: FILES });

		const result = await add([dir]);

		expect(result.code).toBe(0);
		expect(readConfig(sb).jobs.bot.credentialEnv).toEqual({ API_KEY: "api-key" });
		expect(result.stdout).toContain("→ env API_KEY");
	});

	it("refuses env on a credential with required false", async () => {
		sb = box.create();
		const dir = makeFolder({ dg: withBlock({ "api-key": { env: "API_KEY", required: false } }), files: FILES });

		await refused([dir], "a bound credential is required");

		expect(readConfig(sb).jobs).toEqual({});
	});

	it.each(["DG_X", "LD_PRELOAD", "1BAD"])("refuses the block variable %s and names it", async (variable) => {
		sb = box.create();
		const dir = makeFolder({ dg: withBlock({ "api-key": { env: variable } }), files: FILES });

		await refused([dir], variable);

		expect(readConfig(sb).jobs).toEqual({});
	});

	it("refuses two credentials of one job that bind one variable", async () => {
		sb = box.create();
		const dir = makeFolder({
			dg: withBlock({ one: { env: "TOKEN" }, two: { env: "TOKEN" } }),
			files: FILES,
		});

		await refused([dir], '"TOKEN"', "two credentials");
	});
});

describe("job update and credentialEnv", () => {
	it("adds a binding to a file job and keeps the earlier one", async () => {
		sb = box.create();
		await add([makeScript("poll.ts"), "--every", "15m", "--credential", "one=ONE_VAR"]);

		const result = await update(["poll", "--credential", "two=TWO_VAR"]);

		expect(result.code).toBe(0);
		const entry = readConfig(sb).jobs.poll;
		expect(entry.credentials).toEqual(["one", "two"]);
		expect(entry.credentialEnv).toEqual({ ONE_VAR: "one", TWO_VAR: "two" });
	});

	it("refuses a variable that another credential of the job already binds", async () => {
		sb = box.create();
		await add([makeScript("poll.ts"), "--every", "15m", "--credential", "one=TOKEN"]);

		const result = await update(["poll", "--credential", "two=TOKEN"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('"TOKEN"');
		expect(readConfig(sb).jobs.poll.credentialEnv).toEqual({ TOKEN: "one" });
	});

	it("refuses a reserved variable and leaves the entry as it was", async () => {
		sb = box.create();
		await add([makeScript("poll.ts"), "--every", "15m"]);
		const before = readFileSync(sb.paths.daemonConfigPath, "utf8");

		const result = await update(["poll", "--credential", "k=LD_PRELOAD"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("LD_PRELOAD");
		expect(readFileSync(sb.paths.daemonConfigPath, "utf8")).toBe(before);
	});

	it("exits 1 with the repository text for a repository job", async () => {
		sb = box.create();
		await addFixture(sb, makeRepo({ dg: jobDeclaration("bot"), files: FILES }));

		const result = await update(["bot", "--credential", "k=NAME"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: the repository declares this in its "dg" block');
	});

	it("exits 1 with the folder text for a folder job", async () => {
		sb = box.create();
		const dir = makeFolder({ dg: jobDeclaration("bot"), files: FILES });
		await add([dir]);

		const result = await update(["bot", "--credential", "k=NAME"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: the folder declares this in its "dg" block');
	});

	it("prints replaced <job>.credentialEnv when a block update changes the binding", async () => {
		sb = box.create();
		const repo = makeRepo({ dg: withBlock(), files: FILES });
		await addFixture(sb, repo);
		changeBlock(repo, withBlock({ "api-key": { env: "OTHER_KEY" } }));

		const result = await update(["bot", "--yes"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("replaced bot.credentialEnv");
		expect(readConfig(sb).jobs.bot.credentialEnv).toEqual({ OTHER_KEY: "api-key" });
	});

	it("drops credentialEnv when the block no longer binds the credential", async () => {
		sb = box.create();
		const repo = makeRepo({ dg: withBlock(), files: FILES });
		await addFixture(sb, repo);
		changeBlock(repo, withBlock({ "api-key": { prompt: "Key" } }));

		const result = await update(["bot", "--yes"]);

		expect(result.stdout).toContain("replaced bot.credentialEnv");
		expect(readConfig(sb).jobs.bot).not.toHaveProperty("credentialEnv");
	});
});

describe("a hand edit of the jobs table", () => {
	it("makes the entry invalid in job list output when credentialEnv names a reserved variable", async () => {
		sb = box.create();
		await add([makeScript("poll.ts"), "--every", "15m", "--credential", "k=SAFE_NAME"]);
		const config = readConfig(sb);
		config.jobs.poll.credentialEnv = { LD_PRELOAD: "k" };
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config));

		const result = await runJob(["list"], withBun(sb));

		expect(result.stdout + result.stderr).toContain("LD_PRELOAD");
	});
});
