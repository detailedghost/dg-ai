import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlive, isPathInside, scratchDir } from "@dg/common/node";
import type { DiffFile } from "../src/thrash/core";
import {
	API_FETCH_CONCURRENCY,
	API_FETCH_MAX_BYTES,
	API_FETCH_MAX_FILES,
	CLONE_TIMEOUT_MS,
	type CheckoutInput,
	type CheckoutTarget,
	checkoutTreePath,
	prepareSharedClone,
	removeCheckoutTree,
	resolveCheckout,
} from "../src/thrash/checkout";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { makeTempDir } from "./git-repo-fixtures";

cliFixtures.isolateCliTests();

const target: Extract<CheckoutTarget, { mode: "remote" }> = {
	mode: "remote",
	url: "https://github.com/acme/widgets/pull/12",
	provider: "github",
	repo: { host: "github.com", owner: "acme", repo: "widgets" },
	number: 12,
};
const ORIGIN_URL = "https://github.com/acme/widgets.git";
const REAL_GIT = Bun.which("git") ?? "git";
const TOUCH = Bun.which("touch") ?? "touch";
const MKDIR = Bun.which("mkdir") ?? "mkdir";
const DATE = Bun.which("date") ?? "date";
const CHMOD = Bun.which("chmod") ?? "chmod";

let dirs: string[];

beforeEach(() => {
	dirs = [];
});

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
	return cliFixtures.tmp(dirs, prefix);
}

function lines(path: string): string[] {
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

function diffFile(path: string, status: DiffFile["status"] = "modified"): DiffFile {
	return { path, oldPath: path, status, hunkHeaders: [], hunkStarts: [], lines: [] };
}

interface Fixture {
	remote: string;
	baseSha: string;
	headSha: string;
	secondSha: string;
}

function fixtureRemote(opts: { attributes?: string } = {}): Fixture {
	const remote = tmp("checkout-remote-");
	cliFixtures.runGit(["init", "-q"], remote);
	cliFixtures.runGit(["symbolic-ref", "HEAD", "refs/heads/main"], remote);
	cliFixtures.runGit(["config", "user.email", "t@t.t"], remote);
	cliFixtures.runGit(["config", "user.name", "T"], remote);
	const baseSha = cliFixtures.commitFile(remote, "a.txt", "base\n", "chore: base");
	cliFixtures.runGit(["checkout", "-q", "-b", "pr"], remote);
	mkdirSync(join(remote, "src"));
	writeFileSync(join(remote, "src/b.txt"), "head b\n");
	symlinkSync("/etc/hostname", join(remote, "link"));
	if (opts.attributes) writeFileSync(join(remote, ".gitattributes"), opts.attributes);
	cliFixtures.runGit(["add", "-A"], remote);
	cliFixtures.commitFile(remote, "a.txt", "head\n", "feat: head");
	const headSha = cliFixtures.runGit(["rev-parse", "HEAD"], remote).trim();
	cliFixtures.runGit(["update-ref", "refs/pull/12/head", headSha], remote);
	cliFixtures.runGit(["update-ref", "refs/merge-requests/12/head", headSha], remote);
	const secondSha = cliFixtures.commitFile(remote, "a.txt", "second\n", "feat: second");
	cliFixtures.runGit(["update-ref", "refs/pull/13/head", secondSha], remote);
	cliFixtures.runGit(["checkout", "-q", "main"], remote);
	return { remote, baseSha, headSha, secondSha };
}

function cwdRepo(
	fx: Fixture,
	opts: { originUrl?: string | null; singleBranch?: boolean; branch?: string } = {},
): string {
	const dir = join(tmp("checkout-cwd-"), "repo");
	const args = ["clone", "-q", ...(opts.singleBranch ? ["--single-branch", "--branch", "main"] : []), `file://${fx.remote}`, dir];
	cliFixtures.runGit(args, tmp("checkout-clone-parent-"));
	cliFixtures.runGit(["config", "user.email", "t@t.t"], dir);
	cliFixtures.runGit(["config", "user.name", "T"], dir);
	if (opts.originUrl === null) cliFixtures.runGit(["remote", "remove", "origin"], dir);
	else cliFixtures.runGit(["remote", "set-url", "origin", opts.originUrl ?? ORIGIN_URL], dir);
	if (opts.branch) cliFixtures.runGit(["checkout", "-q", opts.branch], dir);
	return dir;
}

function gitConfigFile(body: string): string {
	const file = join(tmp("checkout-gitconfig-"), "gitconfig");
	writeFileSync(file, body);
	return file;
}

function rewriteConfig(from: string, to: string): Record<string, string> {
	return { GIT_CONFIG_GLOBAL: gitConfigFile(`[url "${to}"]\n\tinsteadOf = ${from}\n`) };
}

interface FakeGh {
	log: string;
}

function fakeGh(body: string): FakeGh {
	const dir = tmp("checkout-fake-gh-");
	const log = join(dir, "gh.log");
	writeFakeCli(dir, "gh", `#!/bin/sh\necho "gh $(${DATE} +%s%N) $*" >> "${log}"\n${body}\n`);
	return { log };
}

function cloningGh(fx: Fixture): FakeGh {
	return fakeGh(`if [ "$1" = repo ] && [ "$2" = clone ]; then dir="$4"; shift 5; exec git clone "$@" "file://${fx.remote}" "$dir"; fi
exit 1`);
}

function cloningGlab(fx: Fixture): FakeGh {
	const dir = tmp("checkout-fake-glab-");
	const log = join(dir, "glab.log");
	writeFakeCli(
		dir,
		"glab",
		`#!/bin/sh\necho "glab $(${DATE} +%s%N) $*" >> "${log}"\nif [ "$1" = repo ] && [ "$2" = clone ]; then dir="$4"; shift 5; exec git clone "$@" "file://${fx.remote}" "$dir"; fi\nexit 1\n`,
	);
	return { log };
}

function failingGh(): FakeGh {
	return fakeGh("exit 1");
}

interface ProviderStub {
	calls: string[];
	provider: CheckoutInput["provider"];
}

function providerStub(
	contents: Record<string, string | null | Error> = {},
	delayMs = 0,
): ProviderStub & { maxInFlight: () => number } {
	const calls: string[] = [];
	let inFlight = 0;
	let peak = 0;
	return {
		calls,
		maxInFlight: () => peak,
		provider: {
			async getFileAtRef(_ref, path) {
				calls.push(path);
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
				inFlight -= 1;
				const value = contents[path] ?? null;
				if (value instanceof Error) throw value;
				return value;
			},
		},
	};
}

function input(fx: Pick<Fixture, "headSha">, files: DiffFile[], stub = providerStub()): CheckoutInput {
	return { target, pr: { headSha: fx.headSha }, files, provider: stub.provider };
}

function unrelatedCwd(): string {
	return tmp("checkout-unrelated-");
}

describe("exported limits", () => {
	it("pins the documented constants", () => {
		expect(CLONE_TIMEOUT_MS).toBe(120_000);
		expect(API_FETCH_MAX_FILES).toBe(50);
		expect(API_FETCH_MAX_BYTES).toBe(1_048_576);
		expect(API_FETCH_CONCURRENCY).toBe(8);
	});
});

describe("cwd step", () => {
	it("builds the tree from the cwd repository objects without a provider clone", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx);
		const gh = failingGh();
		const result = await resolveCheckout(input(fx, []), { cwd });
		expect(result.source).toBe("cwd");
		expect(result.headSha).toBe(fx.headSha);
		expect(isPathInside(result.root, scratchDir("thrash"))).toBe(true);
		expect(readFileSync(join(result.root, "a.txt"), "utf8")).toBe("head\n");
		expect(lines(gh.log)).toEqual([]);
	});

	it("leaves the cwd repository unchanged on another branch with an uncommitted change", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx, { branch: "main" });
		writeFileSync(join(cwd, "a.txt"), "dirty\n");
		writeFileSync(join(cwd, "untracked.txt"), "x\n");
		const snapshot = () =>
			[
				cliFixtures.runGit(["status", "--porcelain"], cwd),
				cliFixtures.runGit(["rev-parse", "HEAD"], cwd),
				cliFixtures.runGit(["worktree", "list"], cwd),
				cliFixtures.runGit(["for-each-ref"], cwd),
				readFileSync(join(cwd, ".git/config"), "utf8"),
				readFileSync(join(cwd, "a.txt"), "utf8"),
			].join("\n--\n");
		const before = snapshot();
		const result = await resolveCheckout(input(fx, []), { cwd });
		expect(result.source).toBe("cwd");
		expect(readFileSync(join(result.root, "a.txt"), "utf8")).toBe("head\n");
		expect(snapshot()).toBe(before);
	});

	it("fetches the PR ref from the cwd origin URL when the head SHA is not in the cwd objects", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx, { singleBranch: true });
		const env = rewriteConfig(ORIGIN_URL, `file://${fx.remote}`);
		const result = await resolveCheckout(input(fx, []), { cwd, env });
		expect(result.source).toBe("cwd");
		expect(readFileSync(join(result.root, "a.txt"), "utf8")).toBe("head\n");
		expect(cliFixtures.runGit(["rev-parse", "HEAD"], result.root).trim()).toBe(fx.headSha);
	});

	it("goes to the clone step when the head SHA is missing and the fetch fails", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx, { singleBranch: true });
		const gh = cloningGh(fx);
		const env = rewriteConfig(ORIGIN_URL, "file:///nonexistent/dg-checkout-fixture");
		const result = await resolveCheckout(input(fx, []), { cwd, env });
		expect(result.source).toBe("clone");
		expect(lines(gh.log).filter((line) => line.includes("repo clone"))).toHaveLength(1);
	});

	it("does not run when origin names another repository", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx, { originUrl: "https://github.com/other/widgets.git" });
		cliFixtures.runGit(["remote", "add", "upstream", ORIGIN_URL], cwd);
		failingGh();
		const result = await resolveCheckout(input(fx, []), { cwd });
		expect(result.source).toBe("none");
	});

	it("does not run when the cwd repository has no origin", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx, { originUrl: null });
		failingGh();
		expect((await resolveCheckout(input(fx, []), { cwd })).source).toBe("none");
	});

	it("does not run when origin does not parse", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx, { originUrl: "widgets" });
		failingGh();
		expect((await resolveCheckout(input(fx, []), { cwd })).source).toBe("none");
	});

	it.each([
		["scp form", "git@github.com:acme/widgets.git"],
		["https with .git", "https://github.com/acme/widgets.git"],
		["different case", "https://GitHub.com/ACME/Widgets"],
	])("matches an origin in %s", async (_label, originUrl) => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx, { originUrl });
		failingGh();
		expect((await resolveCheckout(input(fx, []), { cwd })).source).toBe("cwd");
	});

	it("checks out a repository symlink that points outside the tree as a regular file", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx);
		const result = await resolveCheckout(input(fx, []), { cwd });
		const link = join(result.root, "link");
		expect(Bun.spawnSync(["test", "-L", link]).exitCode).not.toBe(0);
		expect(readFileSync(link, "utf8")).toBe("/etc/hostname");
	});

	it("keeps credentials out of the scratch tree config", async () => {
		const fx = fixtureRemote();
		const credentialUrl = "https://user:placeholder@github.com/acme/widgets.git";
		const cwd = cwdRepo(fx, { originUrl: credentialUrl, singleBranch: true });
		const env = rewriteConfig(credentialUrl, `file://${fx.remote}`);
		const result = await resolveCheckout(input(fx, []), { cwd, env });
		expect(result.source).toBe("cwd");
		const config = readFileSync(join(result.root, ".git/config"), "utf8");
		expect(config).not.toContain("placeholder");
		expect(config).not.toContain("user:");
	});

	it("replaces a tree that an earlier run left at the same path", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx);
		const stale = checkoutTreePath(target);
		mkdirSync(stale, { recursive: true });
		writeFileSync(join(stale, "stale.txt"), "old\n");
		const result = await resolveCheckout(input(fx, []), { cwd });
		expect(result.root).toBe(stale);
		expect(existsSync(join(stale, "stale.txt"))).toBe(false);
	});
});

describe("clone step", () => {
	it("clones the target through the provider CLI and checks out the PR head", async () => {
		const fx = fixtureRemote();
		const gh = cloningGh(fx);
		const result = await resolveCheckout(input(fx, []), { cwd: unrelatedCwd() });
		expect(result.source).toBe("clone");
		expect(result.headSha).toBe(fx.headSha);
		expect(isPathInside(result.root, scratchDir("thrash"))).toBe(true);
		expect(readFileSync(join(result.root, "a.txt"), "utf8")).toBe("head\n");
		const call = lines(gh.log)[0] ?? "";
		expect(call).toContain("repo clone github.com/acme/widgets");
		expect(call).toContain("-- --depth 1 --no-checkout --no-tags --no-recurse-submodules");
		expect(call).toContain("core.hooksPath=/dev/null");
		expect(call).not.toContain("credential.helper");
	});

	it("does not run a post-checkout hook from the git templates", async () => {
		const fx = fixtureRemote();
		const templates = tmp("checkout-templates-");
		const marker = join(tmp("checkout-marker-"), "ran");
		mkdirSync(join(templates, "hooks"));
		const hook = join(templates, "hooks/post-checkout");
		writeFileSync(hook, `#!/bin/sh\n${TOUCH} "${marker}"\n`);
		Bun.spawnSync([CHMOD, "+x", hook]);
		const env = { GIT_CONFIG_GLOBAL: gitConfigFile(`[init]\n\ttemplateDir = ${templates}\n`) };
		const control = Bun.spawnSync(["git", "clone", "-q", `file://${fx.remote}`, join(tmp("checkout-control-"), "c")], {
			env: { ...process.env, ...env },
		});
		expect(control.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
		cloningGh(fx);
		const result = await resolveCheckout(input(fx, []), { cwd: unrelatedCwd(), env });
		expect(result.source).toBe("clone");
		expect(existsSync(marker)).toBe(false);
	});

	it("stops a clone that runs past the cap, kills its children and removes the directory", async () => {
		const fx = fixtureRemote();
		const pidFile = join(tmp("checkout-pid-"), "pid");
		fakeGh(`if [ "$1" = repo ]; then ${MKDIR} -p "$4"; ${TOUCH} "$4/partial"; sleep 30 & echo $! > "${pidFile}"; wait; fi
exit 1`);
		const stub = providerStub({ "a.txt": "from api\n" });
		const result = await resolveCheckout(input(fx, [diffFile("a.txt")], stub), {
			cwd: unrelatedCwd(),
			cloneTimeoutMs: 300,
		});
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		for (let attempt = 0; attempt < 40 && isAlive(pid); attempt += 1) await Bun.sleep(25);
		expect(isAlive(pid)).toBe(false);
		expect(existsSync(join(checkoutTreePath(target), "partial"))).toBe(false);
		expect(result.source).toBe("api");
		expect(stub.calls).toEqual(["a.txt"]);
	});

	it("shares one deadline between the cwd fetch and the clone, in step order", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx, { singleBranch: true });
		const env = rewriteConfig(ORIGIN_URL, `file://${fx.remote}`);
		const dir = tmp("checkout-fake-git-");
		const log = join(dir, "calls.log");
		const stalled = join(dir, "stalled");
		writeFakeCli(
			dir,
			"git",
			`#!/bin/sh
echo "git $(${DATE} +%s%N) $*" >> "${log}"
case " $* " in *" fetch "*) if [ ! -f "${stalled}" ]; then ${TOUCH} "${stalled}"; sleep 1; exit 1; fi;; esac
exec "${REAL_GIT}" "$@"
`,
		);
		writeFakeCli(dir, "gh", `#!/bin/sh\necho "gh $(${DATE} +%s%N) $*" >> "${log}"\nsleep 30\n`);
		const stub = providerStub({ "a.txt": "from api\n" });
		const started = Date.now();
		const result = await resolveCheckout(input(fx, [diffFile("a.txt")], stub), {
			cwd,
			env,
			cloneTimeoutMs: 1500,
		});
		const elapsed = Date.now() - started;
		expect(result.source).toBe("api");
		expect(elapsed).toBeGreaterThanOrEqual(1400);
		expect(elapsed).toBeLessThan(2100);
		const order = lines(log).map((line): string | null => {
			if (line.startsWith("gh ")) return "gh clone";
			return line.includes(" fetch ") ? "git fetch" : null;
		});
		const trace = order.filter((step): step is string => step !== null);
		expect(trace[0]).toBe("git fetch");
		expect(trace.indexOf("gh clone")).toBeGreaterThan(0);
		expect(trace.indexOf("gh clone")).toBe(trace.lastIndexOf("gh clone"));
		expect(stub.calls).toEqual(["a.txt"]);
	});
});

describe("api step", () => {
	it("writes only the diff files at the head SHA", async () => {
		const fx = fixtureRemote();
		failingGh();
		const stub = providerStub({ "src/a.ts": "a\n", "b.ts": "b\n" });
		const files = [diffFile("src/a.ts"), diffFile("b.ts", "added"), diffFile("old.ts", "deleted"), diffFile("img.png", "binary")];
		const result = await resolveCheckout(input(fx, files, stub), { cwd: unrelatedCwd() });
		expect(result.source).toBe("api");
		expect(readFileSync(join(result.root, "src/a.ts"), "utf8")).toBe("a\n");
		expect(readFileSync(join(result.root, "b.ts"), "utf8")).toBe("b\n");
		expect(stub.calls.sort()).toEqual(["b.ts", "src/a.ts"]);
		expect(existsSync(join(result.root, "old.ts"))).toBe(false);
	});

	it("skips the step for more files than the limit", async () => {
		const fx = fixtureRemote();
		failingGh();
		const files = Array.from({ length: 51 }, (_, index) => diffFile(`f${index}.ts`));
		const stub = providerStub(Object.fromEntries(files.map((file) => [file.path, "x"])));
		const result = await resolveCheckout(input(fx, files, stub), { cwd: unrelatedCwd() });
		expect(result).toEqual({ root: "", headSha: fx.headSha, source: "none" });
		expect(stub.calls).toEqual([]);
	});

	it("honors a replaced file limit", async () => {
		const fx = fixtureRemote();
		failingGh();
		const stub = providerStub({ "a.ts": "x", "b.ts": "x" });
		const result = await resolveCheckout(input(fx, [diffFile("a.ts"), diffFile("b.ts")], stub), {
			cwd: unrelatedCwd(),
			apiFetchMaxFiles: 1,
		});
		expect(result.source).toBe("none");
		expect(stub.calls).toEqual([]);
	});

	it("returns none when every file comes back null", async () => {
		const fx = fixtureRemote();
		failingGh();
		const stub = providerStub();
		const result = await resolveCheckout(input(fx, [diffFile("a.ts"), diffFile("b.ts")], stub), {
			cwd: unrelatedCwd(),
		});
		expect(result.source).toBe("none");
		expect(result.root).toBe("");
		expect(existsSync(checkoutTreePath(target))).toBe(false);
	});

	it("counts a rejected call as not written and still writes the others", async () => {
		const fx = fixtureRemote();
		failingGh();
		const stub = providerStub({ "bad.ts": new Error("boom"), "good.ts": "ok\n" });
		const result = await resolveCheckout(input(fx, [diffFile("bad.ts"), diffFile("good.ts")], stub), {
			cwd: unrelatedCwd(),
		});
		expect(result.source).toBe("api");
		expect(existsSync(join(result.root, "bad.ts"))).toBe(false);
		expect(readFileSync(join(result.root, "good.ts"), "utf8")).toBe("ok\n");
	});

	it("does not write a file above the byte limit", async () => {
		const fx = fixtureRemote();
		failingGh();
		const stub = providerStub({ "big.txt": "a".repeat(API_FETCH_MAX_BYTES + 1), "small.txt": "ok\n" });
		const result = await resolveCheckout(input(fx, [diffFile("big.txt"), diffFile("small.txt")], stub), {
			cwd: unrelatedCwd(),
		});
		expect(result.source).toBe("api");
		expect(existsSync(join(result.root, "big.txt"))).toBe(false);
		expect(existsSync(join(result.root, "small.txt"))).toBe(true);
	});

	it("runs at most API_FETCH_CONCURRENCY calls at one time", async () => {
		const fx = fixtureRemote();
		failingGh();
		const files = Array.from({ length: 30 }, (_, index) => diffFile(`f${index}.ts`));
		const stub = providerStub(Object.fromEntries(files.map((file) => [file.path, "x"])), 20);
		const result = await resolveCheckout(input(fx, files, stub), { cwd: unrelatedCwd(), apiFetchMaxFiles: 30 });
		expect(result.source).toBe("api");
		expect(stub.calls).toHaveLength(30);
		expect(stub.maxInFlight()).toBe(API_FETCH_CONCURRENCY);
	});

	it("writes nothing outside the tree root for a parent-directory path", async () => {
		const fx = fixtureRemote();
		failingGh();
		const stub = providerStub({ "../escape.txt": "x", "ok.txt": "ok\n" });
		const result = await resolveCheckout(input(fx, [diffFile("../escape.txt"), diffFile("ok.txt")], stub), {
			cwd: unrelatedCwd(),
		});
		expect(stub.calls).toEqual(["ok.txt"]);
		expect(existsSync(join(result.root, "..", "escape.txt"))).toBe(false);
	});

	it("writes nothing for absolute, empty-segment and .git paths", async () => {
		const fx = fixtureRemote();
		failingGh();
		const bad = ["/abs.txt", "a//b.txt", ".git/hooks/x", "a/.GIT/x", "nul\0.txt", ""];
		const stub = providerStub(Object.fromEntries(bad.map((path) => [path, "x"])));
		const result = await resolveCheckout(input(fx, bad.map((path) => diffFile(path)), stub), {
			cwd: unrelatedCwd(),
		});
		expect(result.source).toBe("none");
		expect(stub.calls).toEqual([]);
		expect(existsSync("/abs.txt")).toBe(false);
	});

	it("makes no call for a deleted or binary file", async () => {
		const fx = fixtureRemote();
		failingGh();
		const stub = providerStub({ "gone.ts": "x", "img.png": "x" });
		const result = await resolveCheckout(input(fx, [diffFile("gone.ts", "deleted"), diffFile("img.png", "binary")], stub), {
			cwd: unrelatedCwd(),
		});
		expect(result.source).toBe("none");
		expect(stub.calls).toEqual([]);
	});
});

describe("none and failure handling", () => {
	it("returns none with an empty headSha when the PR has no head SHA", async () => {
		failingGh();
		const stub = providerStub({ "a.ts": "x" });
		const result = await resolveCheckout(
			{ target, pr: null, files: [diffFile("a.ts")], provider: stub.provider },
			{ cwd: unrelatedCwd() },
		);
		expect(result).toEqual({ root: "", headSha: "", source: "none" });
		expect(stub.calls).toEqual([]);
	});

	it("does not throw when the provider CLI is missing", async () => {
		const fx = fixtureRemote();
		const result = await resolveCheckout(input(fx, []), { cwd: unrelatedCwd() });
		expect(result).toEqual({ root: "", headSha: fx.headSha, source: "none" });
	});
});

describe("local target", () => {
	it("returns the git root with the HEAD SHA and changes nothing in a dirty tree", async () => {
		const fx = fixtureRemote();
		const repo = cwdRepo(fx, { branch: "pr" });
		writeFileSync(join(repo, "a.txt"), "dirty\n");
		writeFileSync(join(repo, "new.txt"), "n\n");
		const before = cliFixtures.runGit(["status", "--porcelain"], repo);
		const gh = failingGh();
		const stub = providerStub();
		const result = await resolveCheckout(
			{ target: { mode: "local", root: repo, relPath: "." }, pr: null, files: [], provider: stub.provider },
			{ cwd: unrelatedCwd() },
		);
		expect(result).toEqual({ root: repo, headSha: cliFixtures.runGit(["rev-parse", "HEAD"], repo).trim(), source: "cwd" });
		expect(cliFixtures.runGit(["status", "--porcelain"], repo)).toBe(before);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("dirty\n");
		expect(lines(gh.log)).toEqual([]);
		expect(stub.calls).toEqual([]);
	});
});

describe("shared clone for a stack", () => {
	it("gives each PR its own worktree at its own head SHA from one provider clone", async () => {
		const fx = fixtureRemote();
		const gh = cloningGh(fx);
		const shared = await prepareSharedClone(target);
		expect(shared).not.toBeNull();
		if (!shared) return;
		const second = { ...target, number: 13 };
		const first = await resolveCheckout(input(fx, []), { cwd: unrelatedCwd(), sharedClone: shared });
		const other = await resolveCheckout(
			{ target: second, pr: { headSha: fx.secondSha }, files: [], provider: providerStub().provider },
			{ cwd: unrelatedCwd(), sharedClone: shared },
		);
		expect(first.source).toBe("clone");
		expect(other.source).toBe("clone");
		expect(first.root).not.toBe(other.root);
		expect(readFileSync(join(first.root, "a.txt"), "utf8")).toBe("head\n");
		expect(readFileSync(join(other.root, "a.txt"), "utf8")).toBe("second\n");
		expect(lines(gh.log).filter((line) => line.includes("repo clone"))).toHaveLength(1);
		const list = cliFixtures.runGit(["worktree", "list"], shared.dir);
		expect(list).toContain(first.root);
		expect(list).toContain(other.root);
	});

	it("returns null when the provider clone fails", async () => {
		failingGh();
		expect(await prepareSharedClone(target)).toBeNull();
	});

	it("makes no provider clone for a PR when the shared clone failed", async () => {
		const fx = fixtureRemote();
		const gh = cloningGh(fx);
		const result = await resolveCheckout(input(fx, []), { cwd: unrelatedCwd(), sharedClone: null });
		expect(result.source).toBe("none");
		expect(lines(gh.log).filter((line) => line.includes("repo clone"))).toEqual([]);
	});

	it("still runs the API step when the shared clone failed", async () => {
		const fx = fixtureRemote();
		cloningGh(fx);
		const stub = providerStub({ "a.txt": "api\n" });
		const result = await resolveCheckout(input(fx, [diffFile("a.txt")], stub), {
			cwd: unrelatedCwd(),
			sharedClone: null,
		});
		expect(result.source).toBe("api");
	});
});

const EVIL_SHA = "--upload-pack=x";
const FILTER_ATTRIBUTES = "* filter=evil\n";

function evilFilterEnv(): { env: Record<string, string>; marker: string } {
	const marker = join(tmp("checkout-filter-marker-"), "ran");
	const env = { GIT_CONFIG_GLOBAL: gitConfigFile(`[filter "evil"]\n\tsmudge = ${TOUCH} ${marker} && cat\n`) };
	return { env, marker };
}

describe("attribute filters from the PR", () => {
	it("runs the smudge command in a plain checkout, so the tests below prove something", () => {
		const fx = fixtureRemote({ attributes: FILTER_ATTRIBUTES });
		const { env, marker } = evilFilterEnv();
		const control = Bun.spawnSync(["git", "clone", "-q", "-b", "pr", `file://${fx.remote}`, join(tmp("checkout-control-"), "c")], {
			env: { ...process.env, ...env },
		});
		expect(control.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});

	it("does not run a smudge filter from the PR attributes in the cwd step", async () => {
		const fx = fixtureRemote({ attributes: FILTER_ATTRIBUTES });
		const cwd = cwdRepo(fx);
		const { env, marker } = evilFilterEnv();
		const result = await resolveCheckout(input(fx, []), { cwd, env });
		expect(result.source).toBe("cwd");
		expect(readFileSync(join(result.root, "a.txt"), "utf8")).toBe("head\n");
		expect(existsSync(marker)).toBe(false);
	});

	it("does not run a smudge filter from the PR attributes in the clone step", async () => {
		const fx = fixtureRemote({ attributes: FILTER_ATTRIBUTES });
		cloningGh(fx);
		const { env, marker } = evilFilterEnv();
		const result = await resolveCheckout(input(fx, []), { cwd: unrelatedCwd(), env });
		expect(result.source).toBe("clone");
		expect(existsSync(marker)).toBe(false);
	});

	it("does not run a smudge filter from the PR attributes in a stack worktree", async () => {
		const fx = fixtureRemote({ attributes: FILTER_ATTRIBUTES });
		cloningGh(fx);
		const { env, marker } = evilFilterEnv();
		const shared = await prepareSharedClone(target, { env });
		expect(shared).not.toBeNull();
		if (!shared) return;
		const result = await resolveCheckout(input(fx, []), { cwd: unrelatedCwd(), sharedClone: shared, env });
		expect(result.source).toBe("clone");
		expect(readFileSync(join(result.root, "a.txt"), "utf8")).toBe("head\n");
		expect(existsSync(marker)).toBe(false);
	});
});

describe("head SHA validation", () => {
	it("returns none and runs no command for a head SHA that looks like an option", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx);
		const dir = tmp("checkout-fake-git-");
		const log = join(dir, "calls.log");
		writeFakeCli(dir, "git", `#!/bin/sh\necho "git $*" >> "${log}"\nexec "${REAL_GIT}" "$@"\n`);
		const gh = cloningGh(fx);
		const stub = providerStub({ "a.txt": "x\n" });
		const result = await resolveCheckout(
			{ target, pr: { headSha: EVIL_SHA }, files: [diffFile("a.txt")], provider: stub.provider },
			{ cwd },
		);
		expect(result.source).toBe("none");
		expect(lines(log)).toEqual([]);
		expect(lines(gh.log)).toEqual([]);
		expect(stub.calls).toEqual([]);
	});

	it.each([
		["a short SHA", "abc1234"],
		["an uppercase SHA", "A".repeat(40)],
		["a SHA with a suffix", `${"a".repeat(40)}x`],
	])("returns none for %s", async (_label, headSha) => {
		const fx = fixtureRemote();
		const result = await resolveCheckout({ target, pr: { headSha }, files: [], provider: providerStub().provider }, { cwd: cwdRepo(fx) });
		expect(result.source).toBe("none");
	});

	it("puts --end-of-options before the SHA in checkout and worktree add", async () => {
		const fx = fixtureRemote();
		const cwd = cwdRepo(fx);
		const dir = tmp("checkout-fake-git-");
		const log = join(dir, "calls.log");
		writeFakeCli(dir, "git", `#!/bin/sh\necho "git $*" >> "${log}"\nexec "${REAL_GIT}" "$@"\n`);
		await resolveCheckout(input(fx, []), { cwd });
		cloningGh(fx);
		const shared = await prepareSharedClone(target);
		if (shared) await resolveCheckout(input(fx, []), { cwd: unrelatedCwd(), sharedClone: shared });
		const withSha = lines(log).filter((line) => line.includes(fx.headSha) && /\b(checkout|worktree add|cat-file)\b/.test(line));
		const sensitive = withSha.filter((line) => /\b(checkout|worktree add)\b/.test(line));
		expect(sensitive.length).toBeGreaterThanOrEqual(2);
		for (const line of sensitive) {
			expect(line.indexOf("--end-of-options")).toBeGreaterThan(-1);
			expect(line.indexOf("--end-of-options")).toBeLessThan(line.indexOf(fx.headSha));
		}
	});
});

describe("removeCheckoutTree", () => {
	it("deletes the resolved path of a link that points inside scratch", async () => {
		const root = join(scratchDir("thrash"), "tree-real-target");
		const link = join(scratchDir("thrash"), "tree-link");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "f.txt"), "x\n");
		symlinkSync(root, link);
		await removeCheckoutTree(link);
		expect(existsSync(root)).toBe(false);
		rmSync(link, { force: true });
	});

	it("deletes nothing for a link that points outside scratch", async () => {
		const outside = tmp("checkout-outside-");
		writeFileSync(join(outside, "f.txt"), "x\n");
		mkdirSync(scratchDir("thrash"), { recursive: true });
		const link = join(scratchDir("thrash"), "tree-outside-link");
		symlinkSync(outside, link);
		await removeCheckoutTree(link);
		expect(existsSync(join(outside, "f.txt"))).toBe(true);
		rmSync(link, { force: true });
	});
});

describe("credentials in the scratch tree", () => {
	const gitlabTarget: Extract<CheckoutTarget, { mode: "remote" }> = {
		mode: "remote",
		url: "https://gitlab.com/acme/widgets/-/merge_requests/12",
		provider: "gitlab",
		repo: { host: "gitlab.com", owner: "acme", repo: "widgets" },
		number: 12,
	};
	const TOKEN = "tok-known-value-123";
	const saved = { GH_TOKEN: process.env.GH_TOKEN, GITLAB_TOKEN: process.env.GITLAB_TOKEN };

	beforeEach(() => {
		process.env.GH_TOKEN = TOKEN;
		process.env.GITLAB_TOKEN = TOKEN;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function expectClean(root: string): void {
		const config = readFileSync(join(root, ".git/config"), "utf8");
		expect(config).not.toContain(TOKEN);
		expect(config).not.toMatch(/\/\/[^/\s@]+:[^/\s@]*@/);
	}

	it("keeps GH_TOKEN out of the config of a gh clone tree", async () => {
		const fx = fixtureRemote();
		cloningGh(fx);
		const result = await resolveCheckout(input(fx, []), { cwd: unrelatedCwd() });
		expect(result.source).toBe("clone");
		expectClean(result.root);
	});

	it("keeps GITLAB_TOKEN out of the config of a glab clone tree", async () => {
		const fx = fixtureRemote();
		const glab = cloningGlab(fx);
		const result = await resolveCheckout(
			{ target: gitlabTarget, pr: { headSha: fx.headSha }, files: [], provider: providerStub().provider },
			{ cwd: unrelatedCwd() },
		);
		expect(lines(glab.log)[0]).toContain("repo clone https://gitlab.com/acme/widgets");
		expect(result.source).toBe("clone");
		expectClean(result.root);
	});
});
