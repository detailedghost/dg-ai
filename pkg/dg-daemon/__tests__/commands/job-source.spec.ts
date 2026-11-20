import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { jobSourceDir, jobStateDir } from "@dg/common/node";
import {
	assertPrefixFree,
	classifySource,
	defaultJobSourceDeps,
	displayUrl,
	formatRequest,
	resolveRef,
	splitGitArgument,
} from "../../src/commands/job-source";
import { parseJobs } from "../../src/jobs/config";
import { type GitSourceRecord, readNamedSources, writeSource } from "../../src/jobs/sources";
import * as store from "../../src/server/config-store";
import { readConfigStrict } from "../../src/server/config-store";
import { freshTempDir } from "../utils/daemon-harness";
import {
	commit,
	fileUrl,
	gitIn,
	jobDeclaration,
	makeRepo,
	QUICK_SCRIPT,
	RUN_SCRIPT,
	runJob,
	type RepoFile,
	sandbox,
	type Sandbox,
} from "./job-source-kit";

const box = sandbox();
let sb: Sandbox;
beforeEach(() => {
	sb = box.create();
});
afterEach(() => {
	mock.restore();
	box.cleanup();
});

const ESC = String.fromCharCode(27);
const SHA = /^[0-9a-f]{40}$/;
const NAME = "tools";
const ownFile = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

const twoJobs = () => ({
	jobs: {
		"bot-a": { argv: ["./bin/run"], continuous: true, credentials: ["token", "webhook"] },
		"bot-b": { argv: ["./bin/run"], continuous: true, credentials: ["token", "extra"] },
	},
	credentials: {
		token: {
			prompt: "Bot token",
			source: { type: "aws-secretsmanager", secretId: "bots/a", region: "us-east-1", key: "t", profile: "bot" },
		},
		extra: { required: false, prompt: "Extra" },
	},
});

const repoWith = (dg: unknown = jobDeclaration(), files: Record<string, RepoFile> = {}) =>
	makeRepo({ dg, files: { "bin/run": RUN_SCRIPT, "bin/quick": QUICK_SCRIPT, ...files } });

const cloneOf = (source = NAME) => jobSourceDir(sb.paths, source);

type Before = { config: string | null; sources: string | null };
const snapshot = (): Before => ({
	config: ownFile(sb.paths.daemonConfigPath),
	sources: ownFile(sb.paths.jobSourcesPath),
});
function expectUntouched(before: Before, source = NAME): void {
	expect(snapshot()).toEqual(before);
	expect(existsSync(cloneOf(source))).toBe(false);
}

const addRepo = (repo: { dir: string; sha: string }, extra: string[] = [], over = {}) =>
	runJob(["add", fileUrl(repo), "--name", NAME, ...extra], sb.deps(over));

const failingGit = (stderr = "fatal: unreachable\n") => ({
	runGit: async () => ({ code: 128, stdout: "", stderr }),
});

describe("classifySource", () => {
	it.each([
		"https://host/org/bot",
		"git@host:org/bot.git",
		"ssh://git@host/org/bot.git",
		"file:///tmp/bot",
	])("gives git for %s", (value) => {
		expect(classifySource(value)).toBe("git");
	});

	it.each(["./bot.ts", "../bot", "/tmp/bot", "~/bot.ts", "C:\\bots\\bot.ts", "C:/bots/bot.ts"])(
		"gives path for %s",
		(value) => {
			expect(classifySource(value)).toBe("path");
		},
	);

	it("refuses a bare file name and says how to write a local file", () => {
		expect(() => classifySource("bot.ts")).toThrow(
			'job add: "bot.ts" is not a path or a URL — for a local file write ./bot.ts; for a command put it after a bare --',
		);
	});

	it.each(["-x", "--upload-pack=x"])("refuses a value that starts with a dash: %s", (value) => {
		expect(() => classifySource(value)).toThrow('a URL or a ref cannot start with "-"');
	});

	it.each(["ext::sh -c id", "fd::3", "EXT::x"])("refuses %s", (value) => {
		expect(() => classifySource(value)).toThrow(/the URL scheme "(ext|fd)::" is not allowed/);
	});
});

describe("splitGitArgument", () => {
	it.each([
		["git@host:org/bot.git@v1.2.0", "git@host:org/bot.git", "v1.2.0"],
		["git@host:org/bot.git", "git@host:org/bot.git", null],
		["git@host:bot.git", "git@host:bot.git", null],
		["ssh://git@host/org/bot.git", "ssh://git@host/org/bot.git", null],
		["https://host/org/bot@release/1.0", "https://host/org/bot", "release/1.0"],
		["file:///tmp/bot@v1", "file:///tmp/bot", "v1"],
		["https://user@host/org/bot", "https://user@host/org/bot", null],
		["https://host/org/Bot", "https://host/org/Bot", null],
	])("splits %s", (value, url, ref) => {
		expect(splitGitArgument(value)).toEqual({ url, ref });
	});
});

describe("displayUrl", () => {
	it.each([
		["https://user@host/org/bot", "https://host/org/bot"],
		["ssh://git@host/org/bot.git", "ssh://host/org/bot.git"],
		["git@host:org/bot.git", "host:org/bot.git"],
		["file:///tmp/bot", "file:///tmp/bot"],
	])("removes the user part of %s", (url, shown) => {
		expect(displayUrl(url)).toBe(shown);
	});
});

describe("job add of a URL: refusals before git", () => {
	const refused = async (args: string[], text: string) => {
		const before = snapshot();
		const result = await runJob(["add", ...args], sb.deps());
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(text);
		expect(sb.gitCalls).toEqual([]);
		expect(snapshot()).toEqual(before);
	};

	it("refuses a ref that starts with a dash", async () => {
		await refused(["https://host/org/bot@-x"], 'job add: a URL or a ref cannot start with "-"');
	});

	it("refuses a source name that does not match the name rule", async () => {
		await refused(
			["https://host/org/bad_name"],
			'job add: cannot use "bad_name" as a source name — give one with --name',
		);
	});

	it.each([
		["a derived name", ["https://host/org/pw"]],
		["a given name", ["https://host/org/bot", "--name", "pw"]],
	])("refuses a reserved source name (%s)", async (_label, args) => {
		await refused(args, 'job add: "pw" is a reserved name — give another one with --name');
	});

	it.each(
		[
			["--every", "15m"],
			["--continuous"],
			["--schedule", "* * * * *"],
			["--cron", "* * * * *"],
			["--timeout", "5m"],
			["--feed"],
			["--notify", "me"],
			["--cwd", "/tmp"],
			["--env", "A"],
			["--pass-env", "A"],
			["--env-file", "/tmp/x"],
			["--stop-timeout", "5s"],
		].map((flag) => [flag.join(" "), flag]),
	)("refuses the flag %s", async (_label, flag) => {
		await refused(
			["https://host/org/bot", ...(flag as string[])],
			'job add: the repository declares this in its "dg" block',
		);
	});

	it("refuses a command after --", async () => {
		await refused(
			["https://host/org/bot", "--", "node", "x.js"],
			"job add: a URL takes no command after --",
		);
	});

	it("gives the unknown-option error of commander for --accept", async () => {
		await refused(["--accept", "x", "https://host/org/bot"], "unknown option '--accept'");
	});

	it("refuses an ext:: URL and leaves no marker", async () => {
		const marker = join(freshTempDir("marker"), "touched");
		await refused(
			[`ext::sh -c "touch ${marker}"`],
			'job add: the URL scheme "ext::" is not allowed',
		);
		expect(existsSync(marker)).toBe(false);
	});

	it("refuses a password in the URL and a password in an scp URL", async () => {
		await refused(
			["https://user:pw@host/org/bot"],
			"job add: put no password in the URL — use a git credential helper or an ssh key",
		);
		await refused(["user:pw@host:org/bot.git"], "put no password in the URL");
	});

	it.each(["foo::bar", "git+x::host/repo"])("refuses the transport form %s", async (value) => {
		await refused([value], "is not allowed");
	});

	it.each([
		"https://user%3Apw@host/org/bot",
		"https://user%3apw@host/org/bot",
	])("refuses an encoded password in %s", async (value) => {
		await refused([value], "put no password in the URL");
	});

	it("accepts a user with no password", async () => {
		const result = await runJob(["add", "https://user@host/org/bot"], sb.deps(failingGit()));
		expect(result.stderr).toContain("git clone failed");
		expect(sb.gitCalls[0].args).toContain("https://user@host/org/bot");
	});

	it("sends a local path to the local action", async () => {
		await refused(["./bot.ts"], "job add: no file or folder at");
	});

	it("refuses a bare name that is not a path or a URL", async () => {
		await refused(["bot.ts"], "is not a path or a URL");
	});

	it("reads one bare word with no -- as a source and not as the command", async () => {
		await refused(
			["--name", "x", "--cwd", ".", "--continuous", "node"],
			'job add: "node" is not a path or a URL — for a local file write ./node; for a command put it after a bare --',
		);
	});

	it("refuses a source name that a job of the table already uses as a name", async () => {
		sb = box.create({ tools: { continuous: true, argv: ["/bin/x"], cwd: "/tmp" } });
		await refused(
			["file:///x/repo", "--name", "tools"],
			'job add: "tools" is already used as a credential prefix by tools',
		);
	});

	it("refuses a source name that an entry holds as its grant", async () => {
		sb = box.create({
			poll: { continuous: true, argv: ["/bin/x"], cwd: "/tmp", grant: "tools" },
		});
		await refused(
			["file:///x/repo", "--name", "tools"],
			'job add: "tools" is already used as a credential prefix by poll',
		);
	});

	it("refuses a registry file that is not a JSON object and names the file", async () => {
		mkdirSync(sb.paths.jobsDir, { recursive: true });
		writeFileSync(sb.paths.jobSourcesPath, "[]");
		await refused(["file:///x/repo"], sb.paths.jobSourcesPath);
	});

	it("refuses when git is not installed", async () => {
		const before = snapshot();
		const result = await runJob(
			["add", "file:///x/repo", "--name", NAME],
			sb.deps({ which: () => null }),
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job add: git is not installed");
		expect(sb.gitCalls).toEqual([]);
		expectUntouched(before);
	});

	it("refuses an existing clone folder with no record and leaves it", async () => {
		mkdirSync(cloneOf(), { recursive: true });
		writeFileSync(join(cloneOf(), "keep"), "x");
		const result = await runJob(["add", "file:///x/repo", "--name", NAME], sb.deps());
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`job add: ${cloneOf()} already exists — remove it, then run the command again`,
		);
		expect(sb.gitCalls).toEqual([]);
		expect(existsSync(join(cloneOf(), "keep"))).toBe(true);
	});

	it("refuses a command job whose name is a key of the registry", async () => {
		writeSource(sb.paths, "tools", {
			kind: "git",
			url: "file:///x",
			ref: null,
			sha: "a".repeat(40),
			jobs: ["x"],
			declarationHash: "h",
			credentials: {},
		});
		const result = await runJob(
			["add", "--name", "tools", "--continuous", "--cwd", sb.dgHome, "--", sb.tools.which("tool") as string],
			sb.deps(),
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job add: "tools" is already used as a credential prefix by tools');
	});

	it("refuses a command job with a reserved name", async () => {
		const result = await runJob(
			["add", "--name", "pw", "--continuous", "--cwd", sb.dgHome, "--", sb.tools.which("tool") as string],
			sb.deps(),
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job add: "pw" is a reserved name');
	});
});

describe("job add of a URL: source name", () => {
	it.each([
		["git@host:org/bot.git@v1.2.0", "git@host:org/bot.git"],
		["git@host:org/bot.git", "git@host:org/bot.git"],
		["https://host/org/Bot", "https://host/org/Bot"],
		["git@host:bot.git", "git@host:bot.git"],
		["ssh://git@host/org/bot.git", "ssh://git@host/org/bot.git"],
		["https://host/org/bot@release/1.0", "https://host/org/bot"],
	])("clones %s as the source bot", async (argument, url) => {
		const result = await runJob(["add", argument], sb.deps(failingGit()));

		expect(result.code).toBe(1);
		const clone = sb.gitCalls[0].args;
		expect(clone.slice(-2)).toEqual([url, cloneOf("bot")]);
	});

	it("uses the folder and the credential prefix of --name", async () => {
		const repo = repoWith({
			jobs: { a: { argv: ["./bin/run"], continuous: true, credentials: ["c"] } },
		});

		const result = await runJob(["add", fileUrl(repo), "--name", "tools"], sb.deps());

		expect(result.code).toBe(0);
		expect(existsSync(join(sb.paths.jobsDir, "tools", "bin", "run"))).toBe(true);
		const jobs = readConfigStrict(sb.paths).jobs as Record<string, Record<string, unknown>>;
		expect(jobs.a.grant).toBe("tools");
		expect(result.stdout).toContain("credential prefix: tools/");
	});

	it("takes --label as the name", async () => {
		const repo = repoWith();
		const result = await runJob(["add", fileUrl(repo), "--label", "tools"], sb.deps());
		expect(result.code).toBe(0);
		expect(existsSync(cloneOf("tools"))).toBe(true);
	});

	it("derives a lower-case name from the URL", async () => {
		const repo = repoWith();
		const result = await runJob(["add", fileUrl(repo)], sb.deps());
		expect(result.code).toBe(0);
		expect(existsSync(cloneOf(basename(repo.dir).toLowerCase()))).toBe(true);
	});
});

describe("job add of a URL: the happy path", () => {
	it("writes two entries with one grant, the record and the state folders", async () => {
		const repo = repoWith(twoJobs());

		const result = await addRepo(repo);

		expect(result.code).toBe(0);
		const config = readConfigStrict(sb.paths);
		const parsed = parseJobs(config);
		expect(parsed.every((job) => job.ok)).toBe(true);
		const table = config.jobs as Record<string, Record<string, unknown>>;
		expect(Object.keys(table).sort()).toEqual(["bot-a", "bot-b"]);
		for (const entry of Object.values(table)) {
			expect(entry.grant).toBe(NAME);
			expect(entry.cwd).toBe(cloneOf());
			expect(entry).not.toHaveProperty("enabled");
			expect(entry.argv).toEqual([join(cloneOf(), "bin/run")]);
		}
		const record = (readNamedSources(sb.paths)[NAME] as GitSourceRecord);
		expect(record.sha).toBe(repo.sha);
		expect(record.sha).toMatch(SHA);
		expect(record.url).toBe(fileUrl(repo));
		expect(record.ref).toBeNull();
		expect(record.jobs).toEqual(["bot-a", "bot-b"]);
		expect(record.credentials).toEqual(twoJobs().credentials);
		expect(existsSync(jobStateDir(sb.paths, "bot-a"))).toBe(true);
		expect(existsSync(jobStateDir(sb.paths, "bot-b"))).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(sb.paths.jobSourcesPath).mode & 0o777).toBe(0o600);
		}
	});

	it("prints the result with a short sha and one next line for each job", async () => {
		const repo = repoWith(twoJobs());

		const result = await addRepo(repo);

		expect(result.stdout.split("\n").slice(-3)).toEqual([
			`added jobs from "${NAME}" at ${repo.sha.slice(0, 12)}: bot-a, bot-b`,
			"next: dg job enable bot-a",
			"next: dg job enable bot-b",
		]);
		expect(existsSync(sb.paths.jobSourcesPath)).toBe(true);
		expect(readFileSync(sb.paths.jobSourcesPath, "utf8")).toContain(repo.sha);
	});

	it("keeps pinnedOrigin and each command job", async () => {
		sb = box.create({
			cmd: { continuous: true, argv: ["/bin/x"], cwd: "/tmp" },
		});
		const before = readConfigStrict(sb.paths);

		const result = await addRepo(repoWith());

		expect(result.code).toBe(0);
		const after = readConfigStrict(sb.paths);
		expect(after.pinnedOrigin).toBe(before.pinnedOrigin);
		expect((after.jobs as Record<string, unknown>).cmd).toEqual(
			(before.jobs as Record<string, unknown>).cmd,
		);
	});

	it("pins the head of a branch that is not the default branch", async () => {
		const repo = repoWith();
		const branchSha = commit(repo, { branch: "feature" });

		const result = await runJob(
			["add", `${fileUrl(repo)}@feature`, "--name", NAME],
			sb.deps(),
		);

		expect(result.code).toBe(0);
		const record = (readNamedSources(sb.paths)[NAME] as GitSourceRecord);
		expect(record.sha).toBe(branchSha);
		expect(record.sha).not.toBe(repo.sha);
		expect(record.ref).toBe("feature");
		expect(gitIn(cloneOf(), ["rev-parse", "HEAD"])).toBe(branchSha);
	});

	it("pins the commit of an annotated tag when the default branch has a newer commit", async () => {
		const repo = repoWith();
		const tagged = commit(repo, { tag: "v1" });
		commit(repo, {});

		const result = await runJob(["add", `${fileUrl(repo)}@v1`, "--name", NAME], sb.deps());

		expect(result.code).toBe(0);
		expect((readNamedSources(sb.paths)[NAME] as GitSourceRecord).sha).toBe(tagged);
	});

	it("pins a full commit id", async () => {
		const repo = repoWith();
		const first = repo.sha;
		commit(repo, {});

		const result = await runJob(["add", `${fileUrl(repo)}@${first}`, "--name", NAME], sb.deps());

		expect(result.code).toBe(0);
		expect((readNamedSources(sb.paths)[NAME] as GitSourceRecord).sha).toBe(first);
	});

	it("checks out the commit id and never runs submodule or code paths", async () => {
		const repo = repoWith();
		await addRepo(repo);

		const [clone, , checkout] = sb.gitCalls.map((call) => call.args);
		expect(clone).toEqual([
			"-c",
			"protocol.ext.allow=never",
			"-c",
			"protocol.fd.allow=never",
			"clone",
			"--quiet",
			"--no-recurse-submodules",
			"--",
			fileUrl(repo),
			cloneOf(),
		]);
		expect(checkout.slice(4)).toEqual(["checkout", "--detach", repo.sha, "--"]);
	});
});

describe("job add of a URL: failures leave nothing", () => {
	it("reports the first line of the git stderr and removes a partial clone", async () => {
		const before = snapshot();
		const missing = join(freshTempDir("missing"), "none");

		const result = await runJob(["add", `file://${missing}`, "--name", NAME], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job add: git clone failed: ");
		const text = result.stderr.split("git clone failed: ")[1];
		expect(text.startsWith("Cloning into")).toBe(false);
		expectUntouched(before);
	});

	it("shows a visible escape for an ESC byte in the git stderr", async () => {
		const result = await runJob(
			["add", "file:///x/repo", "--name", NAME],
			sb.deps(failingGit(`fatal: ${ESC}[2Kbad\n`)),
		);

		expect(result.stderr).toContain("job add: git clone failed: fatal: \\u{1b}[2Kbad");
		expect(result.stderr).not.toContain(ESC);
	});

	it("reports an unknown ref and removes the clone", async () => {
		const repo = repoWith();
		const before = snapshot();

		const result = await runJob(["add", `${fileUrl(repo)}@nope`, "--name", NAME], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`job add: ref "nope" does not resolve in ${fileUrl(repo)}`);
		expectUntouched(before);
	});

	it("refuses a short commit id", async () => {
		const repo = repoWith();
		const result = await runJob(
			["add", `${fileUrl(repo)}@${repo.sha.slice(0, 7)}`, "--name", NAME],
			sb.deps(),
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not resolve in");
		expect(existsSync(cloneOf())).toBe(false);
	});

	it("refuses a second add of the same source", async () => {
		const repo = repoWith();
		await addRepo(repo);
		const before = snapshot();
		sb.gitCalls.length = 0;

		const result = await runJob(["add", fileUrl(repo), "--name", NAME], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`source "${NAME}" is already added from ${fileUrl(repo)} — run dg job update bot`,
		);
		expect(sb.gitCalls).toEqual([]);
		expect(snapshot()).toEqual(before);
	});

	it("refuses a source name that uppercase letters make different", async () => {
		const repo = repoWith();
		await addRepo(repo);
		const other = repoWith(jobDeclaration("other"));

		const result = await runJob(["add", fileUrl(other), "--name", "Tools"], sb.deps());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job add: cannot use "Tools" as a source name — give one with --name');
	});

	it("refuses a job name that the table holds", async () => {
		sb = box.create({ bot: { continuous: true, argv: ["/bin/x"], cwd: "/tmp" } });
		const before = snapshot();

		const result = await addRepo(repoWith());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job add: a job named "bot" already exists');
		expectUntouched(before);
	});

	it("refuses a block with no jobs and removes the clone", async () => {
		const repo = repoWith({ jobs: {} });
		const before = snapshot();

		const result = await addRepo(repo);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`job add: ${fileUrl(repo)} declares no jobs`);
		expectUntouched(before);
	});

	it("refuses a package.json with no dg key", async () => {
		const repo = makeRepo({ files: { "package.json": "{}" } });
		const before = snapshot();

		const result = await addRepo(repo);

		expect(result.stderr).toContain(`job add: ${fileUrl(repo)} has no "dg" key in package.json`);
		expectUntouched(before);
	});

	it("refuses a repository with no package.json", async () => {
		const repo = makeRepo({ files: { "README.md": "x" } });
		const result = await addRepo(repo);
		expect(result.stderr).toContain("has no package.json");
		expect(existsSync(cloneOf())).toBe(false);
	});

	it("refuses a package.json that is not JSON without echoing it", async () => {
		const repo = makeRepo({ files: { "package.json": "TOPSECRET not json" } });
		const result = await addRepo(repo);
		expect(result.stderr).toContain("package.json is not valid JSON");
		expect(result.stderr).not.toContain("TOPSECRET");
	});

	it("refuses a package.json above 256 KiB", async () => {
		const repo = makeRepo({
			files: {
				"package.json": JSON.stringify({ pad: "x".repeat(300_000), dg: jobDeclaration() }),
				"bin/run": RUN_SCRIPT,
			},
		});
		const result = await addRepo(repo);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("package.json is larger than 256 KiB");
		expect(existsSync(cloneOf())).toBe(false);
	});

	it("refuses a package.json that is a link and shows no content of the target", async () => {
		const outside = join(freshTempDir("outside"), "target.json");
		writeFileSync(outside, JSON.stringify({ dg: jobDeclaration(), marker: "TOPSECRET" }));
		const repo = repoWith();
		const link = join(repo.dir, "package.json");
		gitIn(repo.dir, ["rm", "-q", "-f", "package.json"]);
		symlinkSync(outside, link);
		commit(repo, {});

		const result = await addRepo(repo);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("package.json is not a regular file");
		expect(`${result.stdout}${result.stderr}`).not.toContain("TOPSECRET");
		expect(existsSync(cloneOf())).toBe(false);
	});

	it("names the unknown keys of the block", async () => {
		const result = await addRepo(repoWith({ ...jobDeclaration(), other: 1 }));
		expect(result.stderr).toContain("job add: unknown key(s): other");
	});

	it("shows an error of the validator with the job name", async () => {
		const result = await addRepo(repoWith({ jobs: { bot: { argv: ["./bin/run"] } } }));
		expect(result.stderr).toContain(
			'job add: job "bot": give exactly one of "continuous", "schedule" or "every"',
		);
	});

	it("refuses an unknown source type", async () => {
		const result = await addRepo(
			repoWith({
				jobs: { bot: { argv: ["./bin/run"], continuous: true, credentials: ["c"] } },
				credentials: { c: { source: { type: "command", secretId: "x", region: "r" } } },
			}),
		);
		expect(result.stderr).toContain('job add: credential "c": unknown source type "command"');
	});

	it("restores the bytes when the second entry write fails", async () => {
		const repo = repoWith(twoJobs());
		const before = snapshot();
		const real = store.writeJobEntry;
		let calls = 0;
		const spy = spyOn(store, "writeJobEntry").mockImplementation((...args) => {
			calls += 1;
			if (calls === 2) throw new Error("disk full");
			return real(...args);
		});

		const result = await addRepo(repo);
		spy.mockRestore();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("disk full");
		expectUntouched(before);
	});

	it("removes the clone and writes nothing when the confirm seam aborts", async () => {
		const before = snapshot();
		const result = await addRepo(repoWith(), [], {
			confirm: async () => {
				throw new Error("aborted");
			},
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("aborted");
		expectUntouched(before);
	});

	it("removes the clone when the daemon config is not valid JSON", async () => {
		writeFileSync(sb.paths.daemonConfigPath, "{ not json");
		const result = await addRepo(repoWith());
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(sb.paths.daemonConfigPath);
		expect(existsSync(cloneOf())).toBe(false);
		expect(ownFile(sb.paths.daemonConfigPath)).toBe("{ not json");
	});
});

describe("job add of a URL: consent", () => {
	it("asks one question and runs nothing for the answer no", async () => {
		const asked: string[] = [];
		const before = snapshot();
		const repo = repoWith({ ...jobDeclaration(), build: ["./bin/quick"] });

		const result = await addRepo(repo, [], {
			confirm: async (question: string) => {
				asked.push(question);
				return false;
			},
		});

		expect(asked).toEqual(["Add these jobs? [y/N]"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job add: declined; nothing was added");
		expect(sb.builds).toEqual([]);
		expectUntouched(before);
	});

	it("prints the request, then fails with no terminal and no --yes", async () => {
		const before = snapshot();
		const asked: string[] = [];

		const result = await addRepo(repoWith(twoJobs()), [], {
			isTerminal: () => false,
			confirm: async (question: string) => {
				asked.push(question);
				return true;
			},
		});

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("sha: ");
		expect(result.stdout).toContain("credential prefix: tools/");
		expect(result.stderr).toContain(
			"job add: consent needs a terminal — run this command in a terminal yourself, or give --yes",
		);
		expect(asked).toEqual([]);
		expectUntouched(before);
	});

	it.each([
		["with no terminal", false],
		["with a terminal", true],
	])("adds with --yes and asks no question %s", async (_label, terminal) => {
		const asked: string[] = [];
		const repo = repoWith({ ...jobDeclaration(), build: ["./bin/quick"] });

		const result = await addRepo(repo, ["--yes"], {
			isTerminal: () => terminal,
			confirm: async (question: string) => {
				asked.push(question);
				return true;
			},
		});

		expect(result.code).toBe(0);
		expect(asked).toEqual([]);
		expect(result.stdout).toContain(`sha: ${repo.sha}`);
		expect(sb.builds).toHaveLength(1);
		expect((readNamedSources(sb.paths)[NAME] as GitSourceRecord).sha).toBe(repo.sha);
	});
});

describe("the default terminal check of the source commands", () => {
	it.each([
		[true, true, true],
		[true, false, false],
		[false, true, false],
	])("with stdin %p and stdout %p gives %p", (stdin, stdout, expected) => {
		const saved = [process.stdin.isTTY, process.stdout.isTTY];
		process.stdin.isTTY = stdin;
		process.stdout.isTTY = stdout;
		try {
			expect(defaultJobSourceDeps().isTerminal()).toBe(expected);
		} finally {
			process.stdin.isTTY = saved[0];
			process.stdout.isTTY = saved[1];
		}
	});
});

describe("the default confirm of the source commands", () => {
	const answer = async (text: string): Promise<{ answer: boolean; stderr: string[]; stdout: string[] }> => {
		const original = Object.getOwnPropertyDescriptor(process, "stdin") as PropertyDescriptor;
		Object.defineProperty(process, "stdin", {
			value: Readable.from(text === "" ? [] : [text]),
			configurable: true,
		});
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const given = await defaultJobSourceDeps().confirm("Add these jobs? [y/N]");
			return {
				answer: given,
				stderr: stderr.mock.calls.map(([chunk]) => String(chunk)),
				stdout: stdout.mock.calls.map(([chunk]) => String(chunk)),
			};
		} finally {
			stderr.mockRestore();
			stdout.mockRestore();
			Object.defineProperty(process, "stdin", original);
		}
	};

	it.each([
		["y\n", true],
		["y", true],
		["YES\n", true],
		["Yes\n", true],
		["\n", false],
		["n\n", false],
		["yep\n", false],
		["", false],
	])("treats %p as %p", async (text, expected) => {
		expect((await answer(text)).answer).toBe(expected);
	});

	it("writes the question to stderr and nothing to stdout", async () => {
		const result = await answer("y\n");

		expect(result.stderr.join("")).toContain("Add these jobs? [y/N]");
		expect(result.stdout.join("")).not.toContain("Add these jobs?");
	});
});

describe("the request text", () => {
	it("holds the sha, each argv, the envFile, the build, the credentials and their sources", async () => {
		const repo = repoWith({
			jobs: {
				"bot-a": {
					argv: ["./bin/run", "--mode", "two words"],
					continuous: true,
					envFile: "bot.env",
					stopTimeoutMs: 9000,
					credentials: ["token"],
				},
			},
			credentials: { token: twoJobs().credentials.token },
			build: ["./bin/quick", "go"],
			requires: ["tool"],
		});
		const result = await addRepo(repo, [], { confirm: async () => false });

		const text = result.stdout;
		expect(text).toContain(`sha: ${repo.sha}`);
		expect(text).toContain(`url: ${fileUrl(repo)}`);
		expect(text).toContain('argv: ' + join(cloneOf(), "bin/run") + ' --mode "two words"');
		expect(text).toContain("continuous: true");
		expect(text).toContain(`envFile: "${join(jobStateDir(sb.paths, "bot-a"), "bot.env")}"`);
		expect(text).toContain("stopTimeoutMs: 9000");
		expect(text).toContain("credential prefix: tools/");
		expect(text).toContain(
			'credential token: required, prompt "Bot token", source aws-secretsmanager secretId="bots/a" region="us-east-1" key="t" profile="bot", used by bot-a',
		);
		expect(text).toContain(`build: ${join(cloneOf(), "bin/quick")} go`);
		expect(text).toContain("requires: tool");
	});

	it("shows a visible escape for an ESC byte in a prompt and in an argv value", async () => {
		const repo = repoWith({
			jobs: {
				bot: {
					argv: ["./bin/run", `${ESC}[2K`],
					continuous: true,
					credentials: ["c"],
				},
			},
			credentials: { c: { prompt: `ask${ESC}[31m` } },
		});

		const result = await addRepo(repo, [], { confirm: async () => false });

		expect(result.stdout).toContain("\\u{1b}[2K");
		expect(result.stdout).toContain("ask\\u{1b}[31m");
		expect(result.stdout).not.toContain(ESC);
		expect(result.stderr).not.toContain(ESC);
	});

	it("keeps one line for each fact when a value holds a newline", () => {
		const text = formatRequest({
			source: "tools",
			url: "file:///x",
			ref: null,
			sha: "a".repeat(40),
			jobs: [
				{ name: "a", entry: { argv: ["/x", "one\ntwo"], continuous: true, cwd: "/c" } },
			],
			credentials: {},
			requires: [],
		});
		expect(text.split("\n").filter((line) => line.startsWith("  argv:"))).toHaveLength(1);
		expect(text).toContain("one\\u{a}two");
	});

	it("removes the user part of the URL", () => {
		const text = formatRequest({
			source: "tools",
			url: "https://me@host/org/bot",
			ref: "v1",
			sha: "a".repeat(40),
			jobs: [],
			credentials: {},
			requires: [],
		});
		expect(text).toContain("url: https://host/org/bot");
		expect(text).toContain("ref: v1");
		expect(text).not.toContain("me@");
	});
});

describe("requires, build and argv[0]", () => {
	it("stops before the question and names a missing program", async () => {
		const asked: string[] = [];
		const repo = repoWith({ ...jobDeclaration(), requires: ["nope-tool"] });
		const before = snapshot();

		const result = await addRepo(repo, [], {
			confirm: async (question: string) => {
				asked.push(question);
				return true;
			},
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job add: required executable(s) do not resolve on PATH: nope-tool",
		);
		expect(asked).toEqual([]);
		expect(result.stdout).toBe("");
		expectUntouched(before);
	});

	it("refuses a requires value that is not an array of names", async () => {
		const result = await addRepo(repoWith({ ...jobDeclaration(), requires: ["a/b"] }));
		expect(result.stderr).toContain(
			'job add: "requires" must be an array of executable names',
		);
	});

	it("refuses a build value that is not a non-empty array of strings", async () => {
		const result = await addRepo(repoWith({ ...jobDeclaration(), build: [] }));
		expect(result.stderr).toContain(
			'job add: "build" must be a non-empty array of non-empty strings',
		);
	});

	it("runs a build one time in the clone after the answer and before sources.json exists", async () => {
		const seen: { cwd: string; sources: boolean; confirmed: boolean }[] = [];
		let confirmed = false;
		const repo = repoWith({ ...jobDeclaration(), build: ["./bin/quick", "x"] });

		const result = await addRepo(repo, [], {
			confirm: async () => {
				confirmed = true;
				return true;
			},
			runBuild: async (_argv: string[], cwd: string) => {
				seen.push({ cwd, sources: existsSync(sb.paths.jobSourcesPath), confirmed });
				return 0;
			},
		});

		expect(result.code).toBe(0);
		expect(seen).toEqual([{ cwd: cloneOf(), sources: false, confirmed: true }]);
	});

	it("runs no command for a block with no build", async () => {
		await addRepo(repoWith());
		expect(sb.builds).toEqual([]);
	});

	it("fails the add when the build exits with 3", async () => {
		const before = snapshot();
		const repo = repoWith({ ...jobDeclaration(), build: ["./bin/quick", "a", "b"] });

		const result = await addRepo(repo, [], { runBuild: async () => 3 });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job add: build failed (exit 3): ./bin/quick a b");
		expectUntouched(before);
	});

	it("fails the add when the build does not start", async () => {
		const before = snapshot();
		const repo = repoWith({ ...jobDeclaration(), build: ["./bin/quick"] });

		const result = await addRepo(repo, [], {
			runBuild: async () => {
				throw new Error("ENOENT");
			},
		});

		expect(result.stderr).toContain("job add: build did not start: ./bin/quick");
		expectUntouched(before);
	});

	it("accepts an argv that a build creates", async () => {
		const repo = repoWith({
			jobs: { bot: { argv: ["./dist/bot"], continuous: true } },
			build: ["./bin/make"],
		}, {
			"bin/make": {
				content: `#!${process.execPath}\nconst fs = require("node:fs");\nfs.mkdirSync("dist", { recursive: true });\nfs.writeFileSync("dist/bot", "#!${process.execPath}\\n");\nfs.chmodSync("dist/bot", 0o755);\n`,
				executable: true,
			},
		});

		const result = await runJob(["add", fileUrl(repo), "--name", NAME], {
			...sb.deps(),
			runBuild: async (argv: string[], cwd: string) =>
				Bun.spawnSync(argv, { cwd, stdout: "ignore", stderr: "ignore" }).exitCode,
		});

		expect(result.code).toBe(0);
		const entry = (readConfigStrict(sb.paths).jobs as Record<string, { argv: string[] }>).bot;
		expect(entry.argv).toEqual([join(cloneOf(), "dist/bot")]);
	});

	it("stores the path that the which seam gives for a bare name", async () => {
		const repo = repoWith({
			jobs: { bot: { argv: ["sh", "run"], continuous: true } },
		});

		const result = await addRepo(repo);

		expect(result.code).toBe(0);
		const entry = (readConfigStrict(sb.paths).jobs as Record<string, { argv: string[] }>).bot;
		expect(entry.argv).toEqual([sb.tools.which("sh") as string, "run"]);
	});

	it("refuses a bare name that does not resolve", async () => {
		const result = await addRepo(
			repoWith({ jobs: { bot: { argv: ["no-such-tool-xyz"], continuous: true } } }),
		);
		expect(result.stderr).toContain(
			'job add: executable "no-such-tool-xyz" does not resolve on PATH',
		);
		expect(existsSync(cloneOf())).toBe(false);
	});

	it("refuses an argv that leaves the repository", async () => {
		const result = await addRepo(
			repoWith({ jobs: { bot: { argv: ["../x"], continuous: true } } }),
		);
		expect(result.stderr).toContain(
			'job add: job "bot": "argv" must stay inside the repository',
		);
	});

	it("refuses an argv[0] that is a link to a file outside the clone", async () => {
		const repo = repoWith();
		gitIn(repo.dir, ["rm", "-q", "-f", "bin/run"]);
		mkdirSync(join(repo.dir, "bin"), { recursive: true });
		symlinkSync(process.execPath, join(repo.dir, "bin/run"));
		commit(repo, {});
		const before = snapshot();

		const result = await addRepo(repo);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'job add: job "bot": "argv" must stay inside the repository',
		);
		expectUntouched(before);
	});

	it("refuses a build[0] that is a link to a file outside the clone before the question", async () => {
		const repo = repoWith({ ...jobDeclaration(), build: ["./bin/make"] });
		symlinkSync(process.execPath, join(repo.dir, "bin/make"));
		commit(repo, {});
		const asked: string[] = [];

		const result = await addRepo(repo, [], {
			confirm: async (question: string) => {
				asked.push(question);
				return true;
			},
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job add: "build" must stay inside the repository');
		expect(asked).toEqual([]);
		expect(existsSync(cloneOf())).toBe(false);
	});

	it("resolves a bare build name with the which seam before the question", async () => {
		const repo = repoWith({ ...jobDeclaration(), build: ["sh", "go"] });

		const result = await addRepo(repo, [], { confirm: async () => false });

		expect(result.stdout).toContain(`build: ${sb.tools.which("sh")} go`);
	});

	it("prints the path of an env file that does not exist", async () => {
		const repo = repoWith({
			jobs: { bot: { argv: ["./bin/run"], continuous: true, envFile: "bot.env" } },
		});

		const result = await addRepo(repo);

		const file = join(jobStateDir(sb.paths, "bot"), "bot.env");
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n").at(-1)).toBe(
			`next: create ${file} with mode 600 before you start bot`,
		);
		expect(existsSync(file)).toBe(false);
		const entry = (readConfigStrict(sb.paths).jobs as Record<string, { envFile: string }>).bot;
		expect(entry.envFile).toBe(file);
	});

	it("prints no create line when the env file exists", async () => {
		const file = join(jobStateDir(sb.paths, "bot"), "bot.env");
		mkdirSync(jobStateDir(sb.paths, "bot"), { recursive: true });
		writeFileSync(file, "A=1\n");
		const repo = repoWith({
			jobs: { bot: { argv: ["./bin/run"], continuous: true, envFile: "bot.env" } },
		});

		const result = await addRepo(repo);

		expect(result.stdout).not.toContain("next: create");
	});

	it.each([["/abs/bot.env"], ["../bot.env"]])("refuses the envFile %s", async (envFile) => {
		const result = await addRepo(
			repoWith({ jobs: { bot: { argv: ["./bin/run"], continuous: true, envFile } } }),
		);
		expect(result.stderr).toContain(
			'job add: job "bot": "envFile" must be a relative path inside the state folder of the job',
		);
	});
});

describe("the git environment", () => {
	it("skips LFS, blocks the fd protocol and stops prompts when there is no terminal", async () => {
		const saved = process.env.GIT_SSH_COMMAND;
		delete process.env.GIT_SSH_COMMAND;
		try {
			const result = await addRepo(repoWith(), [], { isTerminal: () => false });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("consent needs a terminal");
		} finally {
			if (saved !== undefined) process.env.GIT_SSH_COMMAND = saved;
		}

		const [clone] = sb.gitCalls.filter((call) => call.args.includes("clone"));
		expect(clone.args).toContain("protocol.fd.allow=never");
		expect(clone.env.GIT_LFS_SKIP_SMUDGE).toBe("1");
		expect(clone.env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(clone.env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
		expect(clone.stdin).toBe("ignore");
	});

	it("keeps the GIT_SSH_COMMAND of the caller", async () => {
		const saved = process.env.GIT_SSH_COMMAND;
		process.env.GIT_SSH_COMMAND = "ssh -i mine";
		try {
			await runJob(
				["add", "file:///x/repo", "--name", NAME],
				sb.deps({ isTerminal: () => false, ...failingGit() }),
			);
		} finally {
			if (saved === undefined) delete process.env.GIT_SSH_COMMAND;
			else process.env.GIT_SSH_COMMAND = saved;
		}
		expect(sb.gitCalls[0].env.GIT_SSH_COMMAND).toBe("ssh -i mine");
	});

	it("gives git the stdin of the caller at a terminal and sets no prompt guard", async () => {
		await runJob(
			["add", "file:///x/repo", "--name", NAME],
			sb.deps({ isTerminal: () => true, ...failingGit() }),
		);
		const [clone] = sb.gitCalls;
		expect(clone.stdin).toBe("inherit");
		expect(clone.env.GIT_LFS_SKIP_SMUDGE).toBe("1");
		expect(clone.env.GIT_TERMINAL_PROMPT).toBeUndefined();
	});
});

describe("resolveRef", () => {
	async function clone(repo: { dir: string }) {
		const dir = join(freshTempDir("job-clone"), "c");
		const cloned = Bun.spawnSync(["git", "clone", "-q", `file://${repo.dir}`, dir], {
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		});
		if (cloned.exitCode !== 0) throw new Error(`git clone failed: ${cloned.stderr.toString()}`);
		return dir;
	}
	const deps = () => sb.deps() as Parameters<typeof resolveRef>[0];

	it("gives the commit of an annotated tag", async () => {
		const repo = repoWith();
		const tagged = commit(repo, { tag: "v1" });
		const dir = await clone(repo);
		expect(gitIn(dir, ["rev-parse", "v1"])).not.toBe(tagged);

		expect(await resolveRef(deps(), dir, "v1", "u")).toBe(tagged);
	});

	it("gives the tag when a tag and a branch share one name", async () => {
		const repo = repoWith();
		const tagged = commit(repo, { tag: "same" });
		commit(repo, { branch: "same" });
		const dir = await clone(repo);

		expect(await resolveRef(deps(), dir, "same", "u")).toBe(tagged);
	});

	it("gives a branch head, the default head for null and a full commit id", async () => {
		const repo = repoWith();
		const feature = commit(repo, { branch: "feature" });
		const dir = await clone(repo);

		expect(await resolveRef(deps(), dir, "feature", "u")).toBe(feature);
		expect(await resolveRef(deps(), dir, null, "u")).toBe(repo.sha);
		expect(await resolveRef(deps(), dir, feature, "u")).toBe(feature);
	});

	it("exits 1 for an unknown ref and for a short commit id", async () => {
		const repo = repoWith();
		const dir = await clone(repo);

		await expect(resolveRef(deps(), dir, "nope", "file:///u")).rejects.toThrow(
			'job add: ref "nope" does not resolve in file:///u',
		);
		await expect(resolveRef(deps(), dir, repo.sha.slice(0, 8), "u")).rejects.toThrow(
			"does not resolve in",
		);
	});

	it("runs the tag lookup before the branch lookup", async () => {
		const repo = repoWith();
		const dir = await clone(repo);
		await resolveRef(deps(), dir, "main", "u");
		const lookups = sb.gitCalls.map((call) => call.args.at(-1));
		expect(lookups).toEqual(["refs/tags/main^{commit}", "refs/remotes/origin/main^{commit}"]);
	});
});

describe("assertPrefixFree", () => {
	const record = (jobs: string[]) => ({
		kind: "git" as const,
		url: "u",
		ref: null,
		sha: "a".repeat(40),
		jobs,
		declarationHash: "h",
		credentials: {},
	});

	it("passes a free name", () => {
		expect(() => assertPrefixFree("free", { jobs: {} }, {}, "job add:")).not.toThrow();
	});

	it("names the job, the grant owner and the source that hold the prefix", () => {
		const config = { jobs: { poll: { grant: "shared" }, other: {} } };
		expect(() => assertPrefixFree("poll", config, {}, "job add:")).toThrow(
			'job add: "poll" is already used as a credential prefix by poll',
		);
		expect(() => assertPrefixFree("shared", config, {}, "job add:")).toThrow(
			'job add: "shared" is already used as a credential prefix by poll',
		);
		expect(() => assertPrefixFree("tools", {}, { tools: record(["a"]) }, "x:")).toThrow(
			'x: "tools" is already used as a credential prefix by tools',
		);
	});

	it("refuses a reserved name", () => {
		expect(() => assertPrefixFree("db", {}, {}, "job add:")).toThrow(
			'job add: "db" is a reserved name — give another one with --name',
		);
	});
});

describe("job remove of a repository job", () => {
	async function twoAdded() {
		const repo = repoWith(twoJobs());
		await addRepo(repo);
		return repo;
	}

	it("keeps the clone and the record with one job after the first remove", async () => {
		await twoAdded();

		const result = await runJob(["remove", "bot-a"], sb.deps());

		expect(result.code).toBe(0);
		expect(result.stdout.split("\n")).toEqual([
			'removed job "bot-a"',
			`kept state: ${jobStateDir(sb.paths, "bot-a")}`,
			`kept credentials below ${NAME}/`,
		]);
		expect((readNamedSources(sb.paths)[NAME] as GitSourceRecord).jobs).toEqual(["bot-b"]);
		expect(existsSync(cloneOf())).toBe(true);
		expect(Object.keys(readConfigStrict(sb.paths).jobs as object)).toEqual(["bot-b"]);
	});

	it("removes the record and the clone with the last job and keeps the state folders", async () => {
		await twoAdded();
		await runJob(["remove", "bot-a"], sb.deps());

		const result = await runJob(["remove", "bot-b"], sb.deps());

		expect(result.code).toBe(0);
		expect(readNamedSources(sb.paths)).toEqual({});
		expect(existsSync(cloneOf())).toBe(false);
		expect(existsSync(jobStateDir(sb.paths, "bot-a"))).toBe(true);
		expect(existsSync(jobStateDir(sb.paths, "bot-b"))).toBe(true);
	});

	it("leaves a jobs table that equals the table before the add", async () => {
		sb = box.create({ cmd: { continuous: true, argv: ["/bin/x"], cwd: "/tmp" } });
		const before = readConfigStrict(sb.paths).jobs;
		await twoAdded();

		await runJob(["remove", "bot-a"], sb.deps());
		await runJob(["remove", "bot-b"], sb.deps());

		expect(readConfigStrict(sb.paths).jobs).toEqual(before);
	});

	it("prints no credentials line for a job with no credential", async () => {
		await addRepo(repoWith());
		const result = await runJob(["remove", "bot"], sb.deps());
		expect(result.stdout).not.toContain("kept credentials");
	});

	it("removes a record that has no entry", async () => {
		const repo = repoWith();
		await addRepo(repo);
		await runJob(["remove", "bot"], sb.deps());
		writeSource(sb.paths, NAME, {
			kind: "git",
			url: fileUrl(repo),
			ref: null,
			sha: repo.sha,
			jobs: ["bot"],
			declarationHash: "h",
			credentials: {},
		});
		mkdirSync(cloneOf(), { recursive: true });

		const result = await runJob(["remove", "bot"], sb.deps());

		expect(result.code).toBe(0);
		expect(readNamedSources(sb.paths)).toEqual({});
		expect(existsSync(cloneOf())).toBe(false);
	});

	it("removes a command job as before and prints no kept lines", async () => {
		sb = box.create({ cmd: { continuous: true, argv: ["/bin/x"], cwd: "/tmp" } });
		const result = await runJob(["remove", "cmd"], sb.deps());
		expect(result.stdout).toBe('removed job "cmd"');
	});

	it("keeps each command job when it removes a repository job", async () => {
		sb = box.create({ cmd: { continuous: true, argv: ["/bin/x"], cwd: "/tmp" } });
		await addRepo(repoWith());
		await runJob(["remove", "bot"], sb.deps());
		expect(Object.keys(readConfigStrict(sb.paths).jobs as object)).toEqual(["cmd"]);
	});

	it("refuses a flag that the repository block owns on update", async () => {
		await addRepo(repoWith());
		const result = await runJob(["update", "bot", "--timeout", "5m"], sb.deps());
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: the repository declares this in its "dg" block');
	});
});

describe("job list and status of a repository job", () => {
	it("shows source@sha12 in the row and the keys in the json row", async () => {
		const repo = repoWith();
		await addRepo(repo);

		const text = await runJob(["list"], sb.deps());
		const json = await runJob(["list", "--json"], sb.deps());
		const status = await runJob(["status", "bot"], sb.deps());

		expect(text.stdout).toContain(`${NAME}@${repo.sha.slice(0, 12)}`);
		expect(status.stdout).toContain(`${NAME}@${repo.sha.slice(0, 12)}`);
		const row = (JSON.parse(json.stdout) as { jobs: Record<string, unknown>[] }).jobs[0];
		expect(row.source).toBe(NAME);
		expect(row.ref).toBeNull();
		expect(row.sha).toBe(repo.sha);
		expect(String(row.sha)).toHaveLength(40);
	});

	it("gives a command job no source keys", async () => {
		sb = box.create({ cmd: { continuous: true, argv: ["/bin/x"], cwd: "/tmp" } });
		const json = await runJob(["list", "--json"], sb.deps());
		const row = (JSON.parse(json.stdout) as { jobs: Record<string, unknown>[] }).jobs[0];
		expect(row).not.toHaveProperty("source");
		expect(row).not.toHaveProperty("sha");
	});
});

describe("job add of a URL: clone folder and git environment", () => {
	it("keeps a clone folder that another run makes between the check and the clone", async () => {
		const marker = join(cloneOf(), "keep");
		const result = await runJob(
			["add", "file:///x/repo", "--name", NAME],
			sb.deps({
				which: (name) => {
					mkdirSync(cloneOf(), { recursive: true });
					writeFileSync(marker, "other run");
					return sb.tools.which(name);
				},
			}),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("already exists — remove it, then run the command again");
		expect(readFileSync(marker, "utf8")).toBe("other run");
		expect(sb.gitCalls).toEqual([]);
	});

	it("removes the repository variables of the caller from the git environment", async () => {
		const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_CONFIG_PARAMETERS", "GIT_NAMESPACE"];
		const saved = names.map((name) => process.env[name]);
		for (const name of names) process.env[name] = "/nowhere";
		try {
			await runJob(["add", "file:///x/repo", "--name", NAME], sb.deps(failingGit()));
		} finally {
			names.forEach((name, i) => {
				if (saved[i] === undefined) delete process.env[name];
				else process.env[name] = saved[i];
			});
		}
		for (const name of names) expect(sb.gitCalls[0].env).not.toHaveProperty(name);
	});

	it("shows the state folder that already exists for a job", async () => {
		const dir = jobStateDir(sb.paths, "bot");
		mkdirSync(dir, { recursive: true });

		const result = await addRepo(repoWith(), [], { confirm: async () => false });

		expect(result.stdout).toContain(`state folder exists: ${dir} (kept from an earlier job)`);
	});

	it("shows no state folder line for a new job", async () => {
		const result = await addRepo(repoWith(), [], { confirm: async () => false });
		expect(result.stdout).not.toContain("state folder exists");
	});

	it("keeps the clone and names it when the rollback also fails", async () => {
		const real = store.writeJobEntry;
		let calls = 0;
		const spy = spyOn(store, "writeJobEntry").mockImplementation((...args) => {
			calls += 1;
			if (calls === 2) {
				rmSync(sb.paths.daemonConfigPath);
				mkdirSync(sb.paths.daemonConfigPath);
				throw new Error("disk full");
			}
			return real(...args);
		});

		const result = await addRepo(repoWith(twoJobs()));
		spy.mockRestore();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the rollback also failed");
		expect(result.stderr).toContain(`the clone stays at ${cloneOf()}`);
		expect(existsSync(cloneOf())).toBe(true);
	});

	it("quotes a repository value so it cannot fake a field", async () => {
		const repo = repoWith({
			jobs: { bot: { argv: ["./bin/run"], continuous: true, credentials: ["c"] } },
			credentials: {
				c: {
					prompt: 'x", source none, used by "y',
					source: { type: "aws-secretsmanager", secretId: 'a" region="evil', region: "r" },
				},
			},
		});

		const result = await addRepo(repo, [], { confirm: async () => false });

		expect(result.stdout).toContain('prompt "x\\", source none, used by \\"y"');
		expect(result.stdout).toContain('secretId="a\\" region=\\"evil"');
	});
});

describe("job list of a scheduled repository job", () => {
	it("shows source@sha and the json keys", async () => {
		const repo = repoWith({ jobs: { tick: { argv: ["./bin/run"], every: "15m" } } });
		await addRepo(repo);

		const text = await runJob(["list"], sb.deps());
		const json = await runJob(["list", "--json"], sb.deps());

		expect(text.stdout).toContain(`${NAME}@${repo.sha.slice(0, 12)}`);
		const row = (JSON.parse(json.stdout) as { jobs: Record<string, unknown>[] }).jobs[0];
		expect(row.source).toBe(NAME);
		expect(row.sha).toBe(repo.sha);
		expect(row.ref).toBeNull();
	});
});
