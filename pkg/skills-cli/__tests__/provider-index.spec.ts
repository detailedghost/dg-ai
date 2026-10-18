import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getProvider, getProviderForUrl, resetProviderCache } from "../src/provider/index";
import { writeFakeCli } from "./fake-cli";
import { makeGitRepoWithOrigin, makeTempDir } from "./git-repo-fixtures";

import { isolateCliTests } from "./cli-fixtures";

isolateCliTests();

const ENV_KEYS = ["AI_VCS_PROVIDER", "AI_VCS_GITLAB_HOSTS", "VCS_GITLAB_AI_REVIEW_BOT"] as const;

let savedEnv: Record<string, string | undefined>;
let originalCwd: string;
let createdDirs: string[];

beforeEach(() => {
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	originalCwd = process.cwd();
	createdDirs = [];
	resetProviderCache();
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	process.chdir(originalCwd);
	for (const dir of createdDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	resetProviderCache();
});

function tempDir(prefix?: string): string {
	const dir = makeTempDir(prefix);
	createdDirs.push(dir);
	return dir;
}

function repoWithOrigin(url: string): string {
	const dir = makeGitRepoWithOrigin(url);
	createdDirs.push(dir);
	return dir;
}

describe("getProvider — GitHub selection", () => {
	test("AI_VCS_PROVIDER=github selects github capabilities with no git repo required", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		process.chdir(tempDir("provider-index-nonrepo-"));
		const provider = await getProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual(["copilot"]);
		expect(provider.capabilities.nativeStacking).toBe(true);
	});

	test("an origin remote host of github.com selects github capabilities with no env override", async () => {
		process.chdir(repoWithOrigin("https://github.com/acme/widgets.git"));
		const provider = await getProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual(["copilot"]);
	});
});

describe("getProvider — GitLab selection", () => {
	test("AI_VCS_PROVIDER=gitlab selects gitlab capabilities regardless of the git remote", async () => {
		process.env.AI_VCS_PROVIDER = "gitlab";
		process.chdir(repoWithOrigin("https://github.com/acme/widgets.git"));
		const provider = await getProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
		expect(provider.capabilities.nativeStacking).toBe(false);
	});

	test("an origin remote host of gitlab.com selects gitlab capabilities with no env override", async () => {
		process.chdir(repoWithOrigin("https://gitlab.com/acme/widgets.git"));
		const provider = await getProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
	});

	test("an origin remote host listed in AI_VCS_GITLAB_HOSTS selects gitlab capabilities", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "git.selfhosted-example.internal";
		process.chdir(repoWithOrigin("https://git.selfhosted-example.internal/acme/widgets.git"));
		const provider = await getProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
	});
});

describe("getProvider — override bypasses AI_VCS_PROVIDER and git-remote detection entirely", () => {
	test("override='gitlab' wins over a conflicting AI_VCS_PROVIDER=github", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const provider = await getProvider("gitlab");
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
	});

	test("override='github' wins over an origin remote host of gitlab.com", async () => {
		process.chdir(repoWithOrigin("https://gitlab.com/acme/widgets.git"));
		const provider = await getProvider("github");
		expect(provider.capabilities.aiReviewBotNames).toEqual(["copilot"]);
	});

	test("override resolves even when AI_VCS_PROVIDER holds a value detectProvider() would reject outright", async () => {
		process.env.AI_VCS_PROVIDER = "bitbucket";
		const provider = await getProvider("github");
		expect(provider.capabilities.aiReviewBotNames).toEqual(["copilot"]);
	});
});

describe("getProvider — unrecognized host", () => {
	test("throws a clear, actionable error instead of guessing a provider", async () => {
		process.chdir(repoWithOrigin("https://totally-unknown-vcs-host.test/acme/widgets.git"));
		let caught: unknown;
		try {
			await getProvider();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("totally-unknown-vcs-host.test");
	});

	test("a failed detection is not stuck cached — a later call for the same (override, cwd) key self-heals without resetProviderCache()", async () => {
		process.chdir(tempDir("provider-index-selfheal-"));
		let caught: unknown;
		try {
			await getProvider();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);

		process.env.AI_VCS_PROVIDER = "github";
		const provider = await getProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual(["copilot"]);
	});
});

describe("getProvider — caches per (override, cwd)", () => {
	test("repeated calls with the same (override, cwd) resolve to the same provider instance", async () => {
		const dir = tempDir("provider-index-cache-a-");
		process.chdir(dir);
		const first = await getProvider("github");
		const second = await getProvider("github");
		expect(second).toBe(first);
	});

	test("resetProviderCache() causes the next call to re-resolve to a distinct instance", async () => {
		const dir = tempDir("provider-index-cache-b-");
		process.chdir(dir);
		const first = await getProvider("github");
		resetProviderCache();
		const second = await getProvider("github");
		expect(second).not.toBe(first);
	});

	test("a different cwd is a cache miss even with the same override", async () => {
		const dirA = tempDir("provider-index-cache-c-");
		const dirB = tempDir("provider-index-cache-d-");
		process.chdir(dirA);
		const first = await getProvider("github");
		process.chdir(dirB);
		const second = await getProvider("github");
		expect(second).not.toBe(first);
	});

	test("a different override is a cache miss even with the same cwd", async () => {
		const dir = tempDir("provider-index-cache-e-");
		process.chdir(dir);
		const first = await getProvider("github");
		const second = await getProvider("gitlab");
		expect(second).not.toBe(first);
	});

	test("concurrent, unawaited calls with the same (override, cwd) resolve to the same instance (no thundering-herd re-detection)", async () => {
		const dir = tempDir("provider-index-cache-concurrent-");
		process.chdir(dir);
		const [first, second, third] = await Promise.all([
			getProvider("github"),
			getProvider("github"),
			getProvider("github"),
		]);
		expect(second).toBe(first);
		expect(third).toBe(first);
	});
});

describe("getProvider — the (override, cwd) cache genuinely skips re-detection on a cache hit", () => {
	test("a second call survives a remote mutation that would break a fresh detection, until the cache is reset", async () => {
		const dir = repoWithOrigin("https://github.com/acme/widgets.git");
		process.chdir(dir);

		const first = await getProvider();
		expect(first.capabilities.aiReviewBotNames).toEqual(["copilot"]);

		const setUrl = Bun.spawnSync(
			["git", "remote", "set-url", "origin", "https://totally-unknown-vcs-host.test/acme/widgets.git"],
			{ cwd: dir },
		);
		expect(setUrl.exitCode).toBe(0);

		const second = await getProvider();
		expect(second).toBe(first);

		resetProviderCache();
		let caught: unknown;
		try {
			await getProvider();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
	});
});

describe("getProviderForUrl — multiple self-hosted GitLab hosts in one run", () => {
	test("resolves two distinct AI_VCS_GITLAB_HOSTS hosts without collision", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "gitlab-host-a.internal,gitlab-host-b.internal";
		const providerA = await getProviderForUrl("https://gitlab-host-a.internal/team-a/proj-a");
		const providerB = await getProviderForUrl("https://gitlab-host-b.internal/team-b/proj-b");
		expect(providerA.capabilities.aiReviewBotNames).toEqual([]);
		expect(providerB.capabilities.aiReviewBotNames).toEqual([]);
	});

	test("a URL path containing /-/merge_requests/ resolves to gitlab capabilities even on an unlisted host", async () => {
		const provider = await getProviderForUrl("https://vcs.unrecognized-host.test/team/proj/-/merge_requests/42");
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
	});

	test("bypasses the (override, cwd) cache — does not collide with a cached getProvider() result for the same cwd", async () => {
		process.chdir(tempDir("provider-index-forurl-cache-"));
		const cached = await getProvider("github");
		const viaUrl = await getProviderForUrl("https://gitlab.com/acme/widgets");
		expect(viaUrl.capabilities.aiReviewBotNames).toEqual([]);
		expect(cached.capabilities.aiReviewBotNames).toEqual(["copilot"]);
	});

	test("an unrecognized host throws a clear, actionable error naming the offending host, rather than resolving to a guessed provider", async () => {
		let caught: unknown;
		try {
			await getProviderForUrl("https://totally-unknown-vcs-host.test/team/proj");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("totally-unknown-vcs-host.test");
	});
});

describe("getProviderForUrl — leaves the (override, cwd) cache untouched", () => {
	test("a prior getProviderForUrl() call does not satisfy a later ambient getProvider() for the same cwd", async () => {
		process.chdir(tempDir("provider-index-forurl-nopollute-"));
		const viaUrl = await getProviderForUrl("https://gitlab.com/acme/widgets");
		expect(viaUrl.capabilities.aiReviewBotNames).toEqual([]);

		let caught: unknown;
		try {
			await getProvider();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
	});

	test("a github.com URL resolves to github capabilities, mirroring the gitlab cases", async () => {
		const provider = await getProviderForUrl("https://github.com/acme/widgets.git");
		expect(provider.capabilities.aiReviewBotNames).toEqual(["copilot"]);
		expect(provider.capabilities.nativeStacking).toBe(true);
	});

	test("two calls for the same URL each build a fresh provider rather than sharing a cached one", async () => {
		const first = await getProviderForUrl("https://gitlab.com/acme/widgets");
		const second = await getProviderForUrl("https://gitlab.com/acme/widgets");
		expect(second).not.toBe(first);
	});
});

describe("getProvider — cache-key edge cases", () => {
	test("getProvider() and getProvider(undefined) share one cache entry", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		process.chdir(tempDir("provider-index-undefined-key-"));
		const first = await getProvider();
		const second = await getProvider(undefined);
		expect(second).toBe(first);
	});

	test("two concurrent failing no-override calls both reject and leave no poisoned entry behind", async () => {
		process.chdir(tempDir("provider-index-concurrent-fail-"));
		const [a, b] = await Promise.allSettled([getProvider(), getProvider()]);
		expect(a.status).toBe("rejected");
		expect(b.status).toBe("rejected");

		process.env.AI_VCS_PROVIDER = "gitlab";
		const provider = await getProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
	});
});

describe("getProvider — concurrent ambient-host-detection calls avoid a thundering herd of real detections", () => {
	test("three concurrent, unawaited no-override calls resolve to the identical cached instance", async () => {
		const dir = repoWithOrigin("https://github.com/acme/widgets.git");
		process.chdir(dir);

		const [first, second, third] = await Promise.all([getProvider(), getProvider(), getProvider()]);
		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(first.capabilities.aiReviewBotNames).toEqual(["copilot"]);
	});
});

describe("getProvider — a stale in-flight rejection does not evict a newer, already-cached success", () => {
	test("resetProviderCache() between a failing call's start and its rejection leaves a later successful entry intact", async () => {
		const dir = repoWithOrigin("https://totally-unknown-vcs-host.test/acme/widgets.git");
		process.chdir(dir);

		const failing = getProvider();
		resetProviderCache();

		process.env.AI_VCS_PROVIDER = "github";
		const good = await getProvider();
		expect(good.capabilities.aiReviewBotNames).toEqual(["copilot"]);

		await expect(failing).rejects.toThrow();

		const stillCached = await getProvider();
		expect(stillCached).toBe(good);
	});
});

describe("getProvider/getProviderForUrl — real adapter construction (not a stub)", () => {
	const BIN_ENV_KEYS = ["GH_BIN", "GLAB_BIN"] as const;
	let savedBinEnv: Record<string, string | undefined>;
	let binDirs: string[];

	beforeEach(() => {
		savedBinEnv = {};
		for (const k of BIN_ENV_KEYS) {
			savedBinEnv[k] = process.env[k];
			delete process.env[k];
		}
		binDirs = [];
	});

	afterEach(() => {
		for (const k of BIN_ENV_KEYS) {
			if (savedBinEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedBinEnv[k];
		}
		for (const dir of binDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function authOkScript(): string {
		return `#!/bin/sh
case "$*" in
  *"auth status"*)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
	}

	function fakeGhViaBin(): void {
		const dir = mkdtempSync(join(tmpdir(), "provider-index-fakegh-"));
		binDirs.push(dir);
		writeFakeCli(dir, "gh", authOkScript());
		process.env.GH_BIN = join(dir, "gh");
	}

	function fakeGlabOnPath(): void {
		const dir = mkdtempSync(join(tmpdir(), "provider-index-fakeglab-"));
		binDirs.push(dir);
		writeFakeCli(dir, "glab", authOkScript());
	}

	test("getProvider('github') calls through to a real checkAuth() invocation of gh, not ADAPTER_NOT_IMPLEMENTED", async () => {
		fakeGhViaBin();
		process.chdir(tempDir("provider-index-realgh-"));

		const provider = await getProvider("github");
		const authed = await provider.checkAuth();

		expect(authed).toBe(true);
	});

	test("getProvider('gitlab') calls through to a real checkAuth() invocation of glab, not ADAPTER_NOT_IMPLEMENTED", async () => {
		fakeGlabOnPath();
		process.chdir(tempDir("provider-index-realglab-"));

		const provider = await getProvider("gitlab");
		const authed = await provider.checkAuth();

		expect(authed).toBe(true);
	});

	test("getProviderForUrl() on a github.com URL returns a real adapter whose checkAuth() shells out to gh", async () => {
		fakeGhViaBin();

		const provider = await getProviderForUrl("https://github.com/acme/widgets");
		const authed = await provider.checkAuth();

		expect(authed).toBe(true);
	});

	test("getProviderForUrl() on a gitlab.com URL returns a real adapter whose checkAuth() shells out to glab", async () => {
		fakeGlabOnPath();

		const provider = await getProviderForUrl("https://gitlab.com/acme/widgets");
		const authed = await provider.checkAuth();

		expect(authed).toBe(true);
	});

	test("the second, cache-hit call for the same (override, cwd) still returns a provider that shells out for real, not the placeholder", async () => {
		fakeGhViaBin();
		process.chdir(tempDir("provider-index-noplaceholder-"));

		const first = await getProvider("github");
		const second = await getProvider("github");
		expect(second).toBe(first);

		const authed = await second.checkAuth();

		expect(authed).toBe(true);
	});
});
