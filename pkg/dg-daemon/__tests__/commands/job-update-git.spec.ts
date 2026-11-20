import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { jobSourceDir, jobStateDir, writePidFileAtomic } from "@dg/common/node";
import type { JobSourceDeps } from "../../src/commands/job-source";
import * as sources from "../../src/jobs/sources";
import { freshTempDir } from "../utils/daemon-harness";
import { configPathOf } from "../utils/service-daemon";
import {
	homeTracker,
	jobsTable,
	pathsOf,
	postJob,
	runCli,
} from "./job-cli-helpers";
import {
	addFixture,
	changeBlock,
	commit,
	fileUrl,
	gitIn,
	jobDeclaration,
	makeRepo,
	QUICK_SCRIPT,
	RUN_SCRIPT,
	type Repo,
	runJob,
	sandbox,
	type Sandbox,
} from "./job-source-kit";

const box = sandbox(["tool", "sh", "other"]);
let sb: Sandbox;
beforeEach(() => {
	sb = box.create();
});
afterEach(() => box.cleanup());

const NAME = "tools";
const FILES = { "bin/run": RUN_SCRIPT, "bin/quick": QUICK_SCRIPT };
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const twelve = (sha: string) => sha.slice(0, 12);
const clone = () => jobSourceDir(sb.paths, NAME);
const head = () => gitIn(clone(), ["rev-parse", "HEAD"]);
const table = () => jobsTable(JSON.parse(read(sb.paths.daemonConfigPath) as string));
const record = () => JSON.parse(read(sb.paths.jobSourcesPath) as string)[NAME];
const files = () => ({
	config: read(sb.paths.daemonConfigPath),
	sources: read(sb.paths.jobSourcesPath),
});

async function sourced(dg: unknown = jobDeclaration("bot")) {
	const repo = makeRepo({ dg, files: FILES });
	await addFixture(sb, repo);
	return repo;
}

function patchEntry(name: string, patch: Record<string, unknown>): void {
	const config = JSON.parse(read(sb.paths.daemonConfigPath) as string);
	Object.assign(config.jobs[name], patch);
	writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config, null, 2));
}

function dropEntry(name: string): void {
	const config = JSON.parse(read(sb.paths.daemonConfigPath) as string);
	delete config.jobs[name];
	writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config, null, 2));
}

function patchRecord(patch: Record<string, unknown>): void {
	const registry = JSON.parse(read(sb.paths.jobSourcesPath) as string);
	Object.assign(registry[NAME], patch);
	writeFileSync(sb.paths.jobSourcesPath, JSON.stringify(registry, null, 2));
}

function asking(answer = true) {
	const asks: string[] = [];
	return {
		asks,
		over: {
			confirm: async (question: string) => {
				asks.push(question);
				return answer;
			},
		} satisfies Partial<JobSourceDeps>,
	};
}

const update = (args: string[] = [], over: Partial<JobSourceDeps> = {}, job = "bot") =>
	runJob(["update", job, ...args], sb.deps(over));

const addAt = (repo: Repo, ref: string) =>
	runJob(["add", `${fileUrl(repo)}@${ref}`, "--name", NAME, "--yes"], sb.deps());

const NEW_BLOCK = {
	jobs: {
		bot: {
			argv: ["./bin/quick", "x"],
			continuous: true,
			credentials: ["token"],
			envFile: "bot.env",
			stopTimeoutMs: 5000,
		},
	},
	credentials: { token: { prompt: "Token" } },
};

describe("job update of a repository job with no new commit", () => {
	it("tells that no job has the name", async () => {
		const result = await update([], {}, "nope");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "nope"');
	});

	it("exits 0 with the up to date line and changes no byte", async () => {
		const repo = await sourced();
		const before = files();

		const result = await update();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`source "tools" is up to date at ${twelve(repo.sha)}`);
		expect(files()).toEqual(before);
	});

	it("exits 0 with no terminal", async () => {
		await sourced();
		const result = await update([], { isTerminal: () => false });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("is up to date");
	});

	it("keeps local changes of the clone and prints no discarded line", async () => {
		await sourced();
		writeFileSync(join(clone(), "bin/run"), "edited");

		const result = await update();

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("discarded local changes");
		expect(read(join(clone(), "bin/run"))).toBe("edited");
	});

	it("reports up to date for a tag when only the default branch moved", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		commit(repo, { tag: "v1" });
		const tagged = gitIn(repo.dir, ["rev-parse", "HEAD"]);
		await addAt(repo, "v1");
		commit(repo, {});

		const result = await update();

		expect(result.stdout).toContain(`is up to date at ${twelve(tagged)}`);
	});

	it("treats a stored full commit id as up to date", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		await addAt(repo, repo.sha);
		commit(repo, {});

		const result = await update();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("is up to date");
	});
});

describe("job update with a new commit and an equal block", () => {
	it("asks once, writes only the sha and keeps each entry byte-equal", async () => {
		const repo = await sourced();
		const newSha = commit(repo, {});
		const before = files();
		const { asks, over } = asking();

		const result = await update([], over);

		expect(result.code).toBe(0);
		expect(asks).toEqual(["Update to this commit? [y/N]"]);
		expect(result.stdout).toContain(`tools: ${twelve(repo.sha)} -> ${twelve(newSha)}`);
		expect(result.stdout).toContain(
			`updated source "tools" ${twelve(repo.sha)} -> ${twelve(newSha)}`,
		);
		expect(record().sha).toBe(newSha);
		expect(head()).toBe(newSha);
		expect(read(sb.paths.daemonConfigPath)).toBe(before.config);
	});

	it("runs the build once for the accepted commit", async () => {
		const repo = await sourced({ ...jobDeclaration("bot"), build: ["./bin/quick"] });
		commit(repo, {});
		const builds = sb.builds.length;

		const result = await update();

		expect(result.code).toBe(0);
		expect(sb.builds.length - builds).toBe(1);
		expect(sb.builds.at(-1)?.cwd).toBe(clone());
	});

	it("leaves an entry that the owner edited byte-equal", async () => {
		const repo = await sourced();
		patchEntry("bot", { argv: ["/edited"], enabled: true });
		commit(repo, {});
		const before = read(sb.paths.daemonConfigPath);

		await update();

		expect(read(sb.paths.daemonConfigPath)).toBe(before);
	});

	it("leaves an absent entry absent", async () => {
		const repo = await sourced();
		dropEntry("bot");
		commit(repo, {});

		const result = await update();

		expect(result.code).toBe(0);
		expect(table().bot).toBeUndefined();
	});

	it("declines with the old commit kept and no build", async () => {
		const repo = await sourced({ ...jobDeclaration("bot"), build: ["./bin/quick"] });
		commit(repo, {});
		const before = files();
		const builds = sb.builds.length;
		const { over } = asking(false);

		const result = await update([], over);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`job update: declined; source "tools" stays at ${twelve(repo.sha)}`,
		);
		expect(head()).toBe(repo.sha);
		expect(files()).toEqual(before);
		expect(sb.builds.length).toBe(builds);
	});

	it("prints the change and fails with no terminal and no --yes", async () => {
		const repo = await sourced({ ...jobDeclaration("bot"), build: ["./bin/quick"] });
		const newSha = commit(repo, {});
		const before = files();
		const builds = sb.builds.length;
		const { asks, over } = asking();

		const result = await update([], { ...over, isTerminal: () => false });

		expect(result.code).toBe(1);
		expect(result.stdout).toContain(`${twelve(repo.sha)} -> ${twelve(newSha)}`);
		expect(result.stderr).toContain(
			"job update: consent needs a terminal — run this command in a terminal yourself, or give --yes",
		);
		expect(asks).toHaveLength(0);
		expect(sb.builds.length).toBe(builds);
		expect(head()).toBe(repo.sha);
		expect(files()).toEqual(before);
	});

	it("applies with --yes, no terminal, no question and one build", async () => {
		const repo = await sourced({ ...jobDeclaration("bot"), build: ["./bin/quick"] });
		const newSha = commit(repo, {});
		const builds = sb.builds.length;
		const { asks, over } = asking();

		const result = await update(["--yes"], { ...over, isTerminal: () => false });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`${twelve(repo.sha)} -> ${twelve(newSha)}`);
		expect(asks).toHaveLength(0);
		expect(sb.builds.length - builds).toBe(1);
		expect(record().sha).toBe(newSha);
	});
});

describe("job update with a changed block", () => {
	it("asks after the request, replaces the repository keys and keeps enabled and passEnv", async () => {
		const repo = await sourced();
		patchEntry("bot", { enabled: true, passEnv: ["FOO"] });
		const newSha = changeBlock(repo, NEW_BLOCK);
		const { asks, over } = asking();

		const result = await update([], over);

		expect(result.code).toBe(0);
		expect(asks).toEqual(["Apply these changes? [y/N]"]);
		expect(result.stdout).toContain(`sha: ${newSha}`);
		const entry = table().bot;
		expect(entry.argv).toEqual([join(clone(), "bin/quick"), "x"]);
		expect(entry.continuous).toBe(true);
		expect(entry.credentials).toEqual(["token"]);
		expect(entry.grant).toBe(NAME);
		expect(entry.envFile).toBe(join(jobStateDir(sb.paths, "bot"), "bot.env"));
		expect(entry.stopTimeoutMs).toBe(5000);
		expect(entry.enabled).toBe(true);
		expect(entry.passEnv).toEqual(["FOO"]);
		expect(record()).toMatchObject({
			sha: newSha,
			jobs: ["bot"],
			credentials: NEW_BLOCK.credentials,
		});
		expect(head()).toBe(newSha);
	});

	it("prints the updated line, then the replaced lines, then the next lines", async () => {
		const repo = await sourced();
		const newSha = changeBlock(repo, NEW_BLOCK);

		const result = await update();

		const out = result.stdout.split("\n");
		const start = out.findIndex((line) => line.startsWith("updated source"));
		expect(out[start]).toBe(
			`updated source "tools" ${twelve(repo.sha)} -> ${twelve(newSha)}`,
		);
		expect(out.slice(start + 1)).toEqual(
			expect.arrayContaining([
				"replaced bot.argv",
				"replaced bot.credentials",
				"replaced bot.grant",
				"replaced bot.envFile",
				"replaced bot.stopTimeoutMs",
				"next: dg job setup bot",
			]),
		);
		expect(out.some((line) => line.startsWith("next: dg job enable"))).toBe(false);
	});

	it("replaces an argv that the owner edited and names it", async () => {
		const repo = await sourced();
		patchEntry("bot", { argv: ["/edited"] });
		changeBlock(repo, { jobs: { bot: { argv: ["./bin/quick"], continuous: true } } });

		const result = await update();

		expect(table().bot.argv).toEqual([join(clone(), "bin/quick")]);
		expect(result.stdout).toContain("replaced bot.argv");
	});

	it("names the old and the new mode key when the mode changes", async () => {
		const repo = await sourced();
		changeBlock(repo, { jobs: { bot: { argv: ["./bin/run"], every: "30m" } } });

		const result = await update();

		expect(result.stdout).toContain("replaced bot.continuous");
		expect(result.stdout).toContain("replaced bot.every");
		expect(table().bot.every).toBe("30m");
		expect(table().bot.continuous).toBeUndefined();
	});

	it("prints no replaced line for a key with an equal value", async () => {
		const repo = await sourced();
		changeBlock(repo, {
			jobs: { bot: { argv: ["./bin/run"], continuous: true } },
			requires: ["tool"],
		});

		const result = await update();

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("replaced ");
	});

	it("names a repository key that the new block removed", async () => {
		const repo = await sourced({
			jobs: { bot: { argv: ["./bin/run"], every: "15m", timeoutMs: 5000 } },
		});
		changeBlock(repo, { jobs: { bot: { argv: ["./bin/run"], every: "15m" } } });

		const result = await update();

		expect(result.stdout).toContain("replaced bot.timeoutMs");
		expect(table().bot.timeoutMs).toBeUndefined();
	});

	it("leaves no grant key when the new credentials list is empty", async () => {
		const repo = await sourced(NEW_BLOCK);
		changeBlock(repo, jobDeclaration("bot"));

		await update();

		expect(table().bot.grant).toBeUndefined();
		expect(table().bot.credentials).toBeUndefined();
	});

	it("gives a new job an entry with no enabled key, a 0700 state folder and a next line", async () => {
		const repo = await sourced();
		changeBlock(repo, {
			jobs: {
				bot: { argv: ["./bin/run"], continuous: true },
				extra: { argv: ["./bin/run"], continuous: true },
			},
		});

		const result = await update();

		expect(result.code).toBe(0);
		expect(Object.hasOwn(table().extra, "enabled")).toBe(false);
		expect(record().jobs).toEqual(["bot", "extra"]);
		if (process.platform !== "win32") {
			expect(statSync(jobStateDir(sb.paths, "extra")).mode & 0o777).toBe(0o700);
		}
		expect(result.stdout.split("\n")).toContain("next: dg job enable extra");
	});

	it("refuses a new job that the table already holds and changes nothing", async () => {
		const repo = await sourced();
		changeBlock(repo, {
			jobs: {
				bot: { argv: ["./bin/run"], continuous: true },
				taken: { argv: ["./bin/run"], continuous: true },
			},
		});
		const config = JSON.parse(read(sb.paths.daemonConfigPath) as string);
		config.jobs.taken = { continuous: true, argv: ["/x"], cwd: freshTempDir("cwd") };
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config, null, 2));
		const before = files();

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: a job named "taken" already exists');
		expect(head()).toBe(repo.sha);
		expect(files()).toEqual(before);
	});

	it("removes the entry of a removed job and keeps its state folder", async () => {
		const repo = await sourced({
			jobs: {
				bot: { argv: ["./bin/run"], continuous: true },
				old: { argv: ["./bin/run"], continuous: true },
			},
		});
		changeBlock(repo, jobDeclaration("bot"));

		const result = await update();

		expect(result.code).toBe(0);
		expect(table().old).toBeUndefined();
		expect(record().jobs).toEqual(["bot"]);
		expect(statSync(jobStateDir(sb.paths, "old")).isDirectory()).toBe(true);
	});

	it("gives an absent entry a new entry with no enabled key and a next line", async () => {
		const repo = await sourced();
		dropEntry("bot");
		changeBlock(repo, { jobs: { bot: { argv: ["./bin/quick"], continuous: true } } });

		const result = await update();

		expect(Object.hasOwn(table().bot, "enabled")).toBe(false);
		expect(result.stdout.split("\n")).toContain("next: dg job enable bot");
	});

	it("gives a job removed with job remove a new entry when the block still lists it", async () => {
		const repo = await sourced({
			jobs: {
				bot: { argv: ["./bin/run"], continuous: true },
				second: { argv: ["./bin/run"], continuous: true },
			},
		});
		expect((await runJob(["remove", "second"], sb.deps())).code).toBe(0);
		changeBlock(repo, {
			jobs: {
				bot: { argv: ["./bin/run"], continuous: true },
				second: { argv: ["./bin/quick"], continuous: true },
			},
		});

		const result = await update();

		expect(result.code).toBe(0);
		expect(Object.hasOwn(table().second, "enabled")).toBe(false);
		expect([...record().jobs].sort()).toEqual(["bot", "second"]);
		expect(result.stdout.split("\n")).toContain("next: dg job enable second");
	});

	it("shows the old and the new value when only requires changed", async () => {
		const repo = await sourced();
		changeBlock(repo, { ...jobDeclaration("bot"), requires: ["tool"] });
		const { asks, over } = asking();

		const result = await update([], over);

		expect(asks).toEqual(["Apply these changes? [y/N]"]);
		expect(result.stdout).toContain("changed requires: (none) -> tool");
	});

	it("shows the old and the new value when only build changed", async () => {
		const repo = await sourced({ ...jobDeclaration("bot"), build: ["./bin/quick"] });
		changeBlock(repo, { ...jobDeclaration("bot"), build: ["./bin/quick", "2"] });
		const { asks, over } = asking();

		const result = await update([], over);

		expect(asks).toEqual(["Apply these changes? [y/N]"]);
		expect(result.stdout).toContain("changed build: ./bin/quick -> ./bin/quick 2");
	});

	it("shows the old and the new id when only a secret id changed", async () => {
		const withSecret = (secretId: string) => ({
			jobs: { bot: { argv: ["./bin/run"], continuous: true, credentials: ["token"] } },
			credentials: {
				token: {
					prompt: "Token",
					source: { type: "aws-secretsmanager", secretId, region: "us-east-1" },
				},
			},
		});
		const repo = await sourced(withSecret("bots/a"));
		changeBlock(repo, withSecret("bots/b"));
		const { asks, over } = asking();

		const result = await update([], over);

		expect(asks).toEqual(["Apply these changes? [y/N]"]);
		expect(result.stdout).toContain('secretId="bots/a"');
		expect(result.stdout).toContain('secretId="bots/b"');
	});

	it("prints the setup line for a required credential that is new", async () => {
		const repo = await sourced();
		changeBlock(repo, NEW_BLOCK);
		const { asks, over } = asking();

		const result = await update([], over);

		expect(asks).toHaveLength(1);
		expect(result.stdout.split("\n")).toContain("next: dg job setup bot");
	});

	it("prints no setup line for a credential that the old block had", async () => {
		const repo = await sourced(NEW_BLOCK);
		changeBlock(repo, { ...NEW_BLOCK, credentials: { token: { prompt: "Token again" } } });

		const result = await update();

		expect(result.stdout).not.toContain("next: dg job setup");
	});

	it("shows the same request text as add for one block", async () => {
		const repo = await sourced();
		changeBlock(repo, {
			jobs: { bot: { argv: ["./bin/quick"], continuous: true } },
			build: ["./bin/quick"],
		});
		const updated = await update();
		const request = (text: string) => {
			const lines = text.split("\n");
			const from = lines.findIndex((line) => line.startsWith("source: "));
			const to = lines.findIndex((line, index) => index > from && /^(changed|updated|replaced|next|added)/.test(line));
			return lines.slice(from, to).join("\n");
		};
		expect((await runJob(["remove", "bot"], sb.deps())).code).toBe(0);
		rmSync(jobStateDir(sb.paths, "bot"), { recursive: true });

		const added = await runJob(["add", fileUrl(repo), "--name", NAME, "--yes"], sb.deps());

		expect(request(updated.stdout)).toBe(request(added.stdout));
	});

	it("updates two jobs of one repository from the name of the first", async () => {
		const repo = await sourced({
			jobs: {
				bot: { argv: ["./bin/run"], continuous: true },
				second: { argv: ["./bin/run"], continuous: true },
			},
		});
		changeBlock(repo, {
			jobs: {
				bot: { argv: ["./bin/quick"], continuous: true },
				second: { argv: ["./bin/quick"], continuous: true },
			},
		});

		const result = await update();

		expect(result.stdout).toContain("job bot");
		expect(result.stdout).toContain("job second");
		expect(table().bot.argv).toEqual([join(clone(), "bin/quick")]);
		expect(table().second.argv).toEqual([join(clone(), "bin/quick")]);
	});

	it("keeps a record key that it does not know", async () => {
		const repo = await sourced();
		patchRecord({ prefixAccepted: true });
		changeBlock(repo, NEW_BLOCK);

		await update();

		expect(record().prefixAccepted).toBe(true);
	});
});

describe("job update failures leave the old state", () => {
	it("fails a build with exit 3 and keeps the old commit and the bytes", async () => {
		const repo = await sourced();
		const newSha = changeBlock(repo, { ...jobDeclaration("bot"), build: ["./bin/quick"] });
		const before = files();

		const result = await update([], { runBuild: async () => 3 });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`job update: build failed (exit 3); source "tools" stays at ${twelve(repo.sha)} — the clone can hold build output of ${twelve(newSha)}`,
		);
		expect(head()).toBe(repo.sha);
		expect(files()).toEqual(before);
	});

	it("stops before the question when a required name does not resolve", async () => {
		const repo = await sourced();
		changeBlock(repo, { ...jobDeclaration("bot"), requires: ["missing-tool"] });
		const { asks, over } = asking();

		const result = await update([], over);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job update: required executable(s) do not resolve on PATH: missing-tool",
		);
		expect(asks).toHaveLength(0);
		expect(head()).toBe(repo.sha);
	});

	it("stops before the question when a bare argv name does not resolve", async () => {
		const repo = await sourced();
		changeBlock(repo, { jobs: { bot: { argv: ["absent-tool"], continuous: true } } });
		const { asks, over } = asking();

		const result = await update([], over);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job update:");
		expect(asks).toHaveLength(0);
		expect(head()).toBe(repo.sha);
	});

	it("fails a fetch with the first line of the git error and changes nothing", async () => {
		const repo = await sourced();
		const before = files();

		const result = await update([], {
			runGit: async (args) =>
				args.includes("fetch")
					? { code: 128, stdout: "", stderr: "fatal: unreachable\nsecond\n" }
					: { code: 0, stdout: `${fileUrl(repo)}\n`, stderr: "" },
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job update: git fetch failed: fatal: unreachable");
		expect(result.stderr).not.toContain("second");
		expect(files()).toEqual(before);
	});

	it("fails when the stored ref does not resolve after the fetch", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		commit(repo, { branch: "release" });
		await addAt(repo, "release");
		gitIn(repo.dir, ["branch", "-D", "release"]);
		gitIn(clone(), ["update-ref", "-d", "refs/remotes/origin/release"]);

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job update: cannot resolve "release" in tools');
	});

	it("fails a checkout with the first line of the git error and keeps the files", async () => {
		const repo = await sourced();
		changeBlock(repo, NEW_BLOCK);
		const before = files();
		const real = sb.deps().runGit as NonNullable<JobSourceDeps["runGit"]>;

		const result = await update([], {
			runGit: (args, options) =>
				args.includes("checkout")
					? Promise.resolve({ code: 1, stdout: "", stderr: "error: boom\nmore\n" })
					: real(args, options),
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job update: git checkout failed: error: boom");
		expect(files()).toEqual(before);
		expect(head()).toBe(repo.sha);
	});

	it("names the clone when the checkout of the old commit also fails", async () => {
		const repo = await sourced({ ...jobDeclaration("bot"), build: ["./bin/quick"] });
		changeBlock(repo, { ...jobDeclaration("bot"), build: ["./bin/quick", "2"] });
		const real = sb.deps().runGit as NonNullable<JobSourceDeps["runGit"]>;
		let checkouts = 0;

		const result = await update([], {
			runBuild: async () => 3,
			runGit: (args, options) => {
				if (args.includes("checkout")) {
					checkouts += 1;
					if (checkouts === 2) {
						return Promise.resolve({ code: 1, stdout: "", stderr: "error: stuck\n" });
					}
				}
				return real(args, options);
			},
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("build failed (exit 3)");
		expect(result.stderr).toContain("error: stuck");
		expect(result.stderr).toContain(clone());
		expect(result.stderr).toContain(`not at ${twelve(repo.sha)}`);
	});

	it("refuses an argv that is a link to a file outside the clone", async () => {
		const repo = await sourced();
		const outside = join(freshTempDir("outside"), "run");
		writeFileSync(outside, "#!/bin/sh\n", { mode: 0o755 });
		rmSync(join(repo.dir, "bin/run"));
		symlinkSync(outside, join(repo.dir, "bin/run"));
		commit(repo, { dg: { ...jobDeclaration("bot"), requires: ["tool"] } });
		const before = files();

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job update:");
		expect(result.stderr).toContain("must stay inside the repository");
		expect(head()).toBe(repo.sha);
		expect(files()).toEqual(before);
	});

	it("stops when the config changes during the question", async () => {
		const repo = await sourced();
		commit(repo, {});

		const result = await update([], {
			confirm: async () => {
				patchEntry("bot", { enabled: true });
				return true;
			},
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job update: the source or the daemon config changed during the question — nothing was changed",
		);
		expect(head()).toBe(repo.sha);
		expect(record().sha).toBe(repo.sha);
	});

	it("stops when the record changes during the question", async () => {
		const repo = await sourced();
		commit(repo, {});

		const result = await update([], {
			confirm: async () => {
				patchRecord({ prefixAccepted: true });
				return true;
			},
		});

		expect(result.stderr).toContain("changed during the question");
		expect(head()).toBe(repo.sha);
	});

	it("restores the bytes and the clone when the registry write fails", async () => {
		const repo = await sourced();
		changeBlock(repo, NEW_BLOCK);
		const before = files();
		const spy = spyOn(sources, "writeSource").mockImplementation(() => {
			throw new Error("disk full");
		});

		const result = await update();
		spy.mockRestore();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("disk full");
		expect(files()).toEqual(before);
		expect(head()).toBe(repo.sha);
	});

	it("names the file when the daemon config is not valid JSON", async () => {
		const repo = await sourced();
		commit(repo, {});
		writeFileSync(sb.paths.daemonConfigPath, "{ not json");

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(sb.paths.daemonConfigPath);
		expect(head()).toBe(repo.sha);
	});

	it("refuses when a daemon pid is alive and does not answer", async () => {
		const repo = await sourced();
		commit(repo, {});
		writePidFileAtomic(sb.paths, {
			pid: process.pid,
			port: 1,
			instanceId: crypto.randomUUID(),
			versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
		});
		const before = files();

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not answer");
		expect(files()).toEqual(before);
		expect(head()).toBe(repo.sha);
	});

	it.each([
		["no dg key", () => ({ name: "x" }), 'has no "dg" key'],
		["an unknown key", () => ({ dg: { jobs: {}, bogus: 1 } }), "unknown key(s): bogus"],
		[
			"an entry the validator refuses",
			() => ({ dg: { jobs: { bot: { argv: ["./bin/run"] } } } }),
			'job "bot"',
		],
	])("refuses a new commit with %s", async (_label, make, text) => {
		const repo = await sourced();
		writeFileSync(join(repo.dir, "package.json"), JSON.stringify(make()));
		gitIn(repo.dir, ["add", "-A"]);
		gitIn(repo.dir, ["commit", "-m", "bad"]);
		const before = files();

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job update:");
		expect(result.stderr).toContain(text);
		expect(head()).toBe(repo.sha);
		expect(files()).toEqual(before);
	});
});

describe("job update checks the record and the clone before git", () => {
	it("refuses a ref that starts with a dash and starts no git process", async () => {
		await sourced();
		patchRecord({ ref: "--upload-pack=x" });
		const calls = sb.gitCalls.length;

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`the record of "tools" in ${sb.paths.jobSourcesPath} is not valid`,
		);
		expect(sb.gitCalls.length).toBe(calls);
	});

	it("refuses an origin URL that is not the URL of the record and starts no fetch", async () => {
		await sourced();
		gitIn(clone(), ["remote", "set-url", "origin", "file:///elsewhere"]);
		const calls = sb.gitCalls.length;

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("is not valid");
		expect(sb.gitCalls.slice(calls).some(({ args }) => args.includes("fetch"))).toBe(false);
	});

	for (const flag of [
		["--every", "30m"],
		["--timeout", "30m"],
		["--notify", "x"],
		["--continuous"],
		["--feed"],
	]) {
		it(`refuses ${flag[0]} on a repository job and starts no git process`, async () => {
			await sourced();
			const calls = sb.gitCalls.length;

			const result = await update(flag);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				'job update: the repository declares this in its "dg" block',
			);
			expect(sb.gitCalls.length).toBe(calls);
		});
	}

	it("gives each git call the hardened options and the environment rules of add", async () => {
		const repo = await sourced();
		commit(repo, {});
		const calls = sb.gitCalls.length;

		await update(["--yes"], { isTerminal: () => false });

		const made = sb.gitCalls.slice(calls);
		expect(made.length).toBeGreaterThan(0);
		for (const call of made) {
			expect(call.args.slice(0, 4)).toEqual([
				"-c",
				"protocol.ext.allow=never",
				"-c",
				"protocol.fd.allow=never",
			]);
			expect(call.env.GIT_LFS_SKIP_SMUDGE).toBe("1");
			expect(call.env.GIT_TERMINAL_PROMPT).toBe("0");
			expect(call.stdin).toBe("ignore");
		}
		const fetch = made.find(({ args }) => args.includes("fetch"));
		expect(fetch?.args.slice(4)).toEqual([
			"-c",
			`core.hooksPath=${devNull}`,
			"-c",
			"core.fsmonitor=false",
			"fetch",
			"--tags",
			"--force",
			"--prune",
			"--prune-tags",
			"--no-recurse-submodules",
			"origin",
		]);
		for (const verb of ["status", "checkout"]) {
			const call = made.find(({ args }) => args.includes(verb));
			expect(call?.args.slice(4, 8)).toEqual([
				"-c",
				`core.hooksPath=${devNull}`,
				"-c",
				"core.fsmonitor=false",
			]);
		}
	});

	it("puts a clone with local changes back to the stored commit before the checkout", async () => {
		const repo = await sourced();
		const newSha = commit(repo, {});
		writeFileSync(join(clone(), "bin/run"), "edited");
		const calls = sb.gitCalls.length;

		const result = await update();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('discarded local changes in the clone of "tools"');
		const checkouts = sb.gitCalls
			.slice(calls)
			.filter(({ args }) => args.includes("checkout"))
			.map(({ args }) => args.slice(8));
		expect(checkouts[0]).toEqual(["checkout", "--force", "--detach", repo.sha, "--"]);
		expect(checkouts[1]).toEqual(["checkout", "--detach", newSha, "--"]);
		expect(head()).toBe(newSha);
	});

	it("puts a clone whose head moved back to the stored commit", async () => {
		const repo = await sourced();
		const newSha = commit(repo, {});
		gitIn(clone(), ["fetch", "--tags", "origin"]);
		gitIn(clone(), ["checkout", "--detach", newSha]);

		const result = await update();

		expect(result.stdout).toContain("discarded local changes");
		expect(record().sha).toBe(newSha);
	});

	it("leaves the clone untouched on a refusal and on the answer n", async () => {
		const repo = await sourced();
		commit(repo, {});
		writeFileSync(join(clone(), "bin/run"), "edited");

		const result = await update([], asking(false).over);

		expect(result.code).toBe(1);
		expect(result.stdout).not.toContain("discarded local changes");
		expect(read(join(clone(), "bin/run"))).toBe("edited");
	});
});

describe("job update treats a pinned commit id as a commit only", () => {
	it("ignores a tag named after the pinned sha and reports up to date", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		await addAt(repo, repo.sha);
		const other = commit(repo, {});
		gitIn(repo.dir, ["tag", repo.sha, other]);

		const result = await update();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`is up to date at ${twelve(repo.sha)}`);
	});

	it("pins the sha of an add even when a tag has the same name", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		const other = commit(repo, {});
		gitIn(repo.dir, ["tag", repo.sha, other]);

		const result = await addAt(repo, repo.sha);

		expect(result.code).toBe(0);
		expect(record().sha).toBe(repo.sha);
	});

	it("compares the raw origin URL and not the insteadOf rewrite", async () => {
		const repo = await sourced();
		gitIn(clone(), ["config", "url.file:///elsewhere/.insteadOf", fileUrl(repo)]);
		commit(repo, {});
		const calls = sb.gitCalls.length;

		const result = await update();

		expect(result.stderr).not.toContain("is not valid");
		expect(sb.gitCalls.slice(calls).some(({ args }) => args.includes("fetch"))).toBe(true);
	});

	it("refuses an origin with two URLs and starts no fetch", async () => {
		await sourced();
		gitIn(clone(), ["config", "--add", "remote.origin.url", "file:///elsewhere"]);
		const calls = sb.gitCalls.length;

		const result = await update();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("is not valid");
		expect(sb.gitCalls.slice(calls).some(({ args }) => args.includes("fetch"))).toBe(false);
	});

	it("drops a deleted remote tag so a branch of that name resolves", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		commit(repo, { branch: "rel" });
		gitIn(repo.dir, ["tag", "rel"]);
		await addAt(repo, "rel");
		gitIn(repo.dir, ["tag", "-d", "rel"]);
		const moved = commit(repo, { branch: "rel" });

		const result = await update();

		expect(result.code).toBe(0);
		expect(record().sha).toBe(moved);
	});

	it("still tries the old commit and names the clone when the rollback of the files fails", async () => {
		const repo = await sourced();
		changeBlock(repo, NEW_BLOCK);
		const spy = spyOn(sources, "writeSource").mockImplementation(() => {
			rmSync(sb.paths.jobSourcesPath);
			mkdirSync(sb.paths.jobSourcesPath);
			throw new Error("disk full");
		});

		const result = await update();
		spy.mockRestore();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the rollback also failed");
		expect(result.stderr).toContain(`the clone ${clone()} is at ${twelve(repo.sha)}`);
		expect(head()).toBe(repo.sha);
	});
});

describe("job update follows the ref", () => {
	it("moves a branch source to the new head of its branch", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		commit(repo, { branch: "release" });
		await addAt(repo, "release");
		const moved = commit(repo, { branch: "release" });

		const result = await update();

		expect(result.code).toBe(0);
		expect(record().sha).toBe(moved);
	});

	it("follows a lightweight tag that the remote moved", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		gitIn(repo.dir, ["tag", "v1"]);
		await addAt(repo, "v1");
		const moved = commit(repo, {});
		gitIn(repo.dir, ["tag", "-f", "v1"]);

		await update();

		expect(record().sha).toBe(moved);
	});

	it("follows an annotated tag that the remote moved", async () => {
		const repo = makeRepo({ dg: jobDeclaration("bot"), files: FILES });
		commit(repo, { tag: "v1" });
		await addAt(repo, "v1");
		const moved = commit(repo, {});
		gitIn(repo.dir, ["tag", "-f", "-a", "v1", "-m", "v1"]);

		await update();

		expect(record().sha).toBe(moved);
	});

	it("follows the new default branch of the remote for a source with no ref", async () => {
		const repo = await sourced();
		gitIn(repo.dir, ["branch", "-m", "main", "trunk"]);
		const moved = commit(repo, {});

		const result = await update();

		expect(result.code).toBe(0);
		expect(record().sha).toBe(moved);
	});
});

describe("job update of other jobs", () => {
	it("accepts --yes on a command job and changes nothing", async () => {
		const cmd = {
			continuous: true,
			argv: [process.execPath, "-e", "1"],
			cwd: freshTempDir("cwd"),
		};
		const config = JSON.parse(read(sb.paths.daemonConfigPath) as string);
		config.jobs.cmd = cmd;
		writeFileSync(sb.paths.daemonConfigPath, JSON.stringify(config, null, 2));
		const before = files();

		const result = await runJob(["update", "cmd", "--yes"], sb.deps());

		expect(result.code).toBe(0);
		expect(files()).toEqual(before);
	});
});

describe("job update with a live daemon", () => {
	const homes = homeTracker();
	afterEach(() => homes.cleanup());

	const script = (body: string) => ({
		content: `#!${process.execPath}\n${body}\n`,
		executable: true as const,
	});
	const repoOf = (dg: unknown): Repo =>
		makeRepo({
			dg,
			files: {
				"bin/run": script("setTimeout(() => {}, 600000);"),
				"bin/crash": script("process.exit(1);"),
			},
		});
	const addOn = (dgHome: string, repo: Repo, port: number) =>
		runCli(dgHome, ["job", "add", fileUrl(repo), "--name", NAME, "--yes"], { port });
	const snapshot = (dgHome: string) => [
		read(configPathOf(dgHome)),
		read(pathsOf(dgHome).jobSourcesPath),
	];

	it("refuses a running job of the source before the question and changes nothing", async () => {
		const { dgHome, port } = await homes.boot();
		const repo = repoOf({
			jobs: {
				bot: { argv: ["./bin/run"], continuous: true },
				other: { argv: ["./bin/run"], continuous: true },
			},
		});
		expect((await addOn(dgHome, repo, port)).code).toBe(0);
		expect((await postJob(port, "bot", "start")).ok).toBe(true);
		commit(repo, {
			dg: { jobs: { bot: { argv: ["./bin/run"], continuous: true } } },
		});
		const clonePath = jobSourceDir(pathsOf(dgHome), NAME);
		const before = snapshot(dgHome);
		const headBefore = gitIn(clonePath, ["rev-parse", "HEAD"]);

		const result = await runCli(dgHome, ["job", "update", "other", "--yes"], { port });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job "bot" is running — stop it first with dg job stop bot');
		expect(snapshot(dgHome)).toEqual(before);
		expect(gitIn(clonePath, ["rev-parse", "HEAD"])).toBe(headBefore);
		await postJob(port, "bot", "stop");
	});

	it("refuses a job in backoff with no next line and no note line", async () => {
		const { dgHome, port } = await homes.boot();
		const repo = repoOf({ jobs: { crash: { argv: ["./bin/crash"], continuous: true } } });
		expect((await addOn(dgHome, repo, port)).code).toBe(0);
		expect((await postJob(port, "crash", "start")).ok).toBe(true);
		commit(repo, {});
		let result = await runCli(dgHome, ["job", "update", "crash", "--yes"], { port });
		for (let i = 0; i < 40 && !result.stderr.includes("is backoff"); i++) {
			await Bun.sleep(100);
			result = await runCli(dgHome, ["job", "update", "crash", "--yes"], { port });
		}

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'job "crash" is backoff — stop it first with dg job stop crash',
		);
		expect(result.stdout).not.toContain("next:");
		expect(result.stderr).not.toContain("note:");
	});
});
