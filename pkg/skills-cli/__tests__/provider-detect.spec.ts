import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { detectProvider } from "../src/provider/detect";
import { ProviderError } from "../src/provider/types";
import { writeFakeCli } from "./fake-cli";
import { makeGitRepo, makeGitRepoWithOrigin, makeTempDir } from "./git-repo-fixtures";

import { isolateCliTests } from "./cli-fixtures";

isolateCliTests();

const ENV_KEYS = ["AI_VCS_PROVIDER", "AI_VCS_GITLAB_HOSTS"] as const;

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
});

function repo(): string {
	const dir = makeGitRepo();
	createdDirs.push(dir);
	return dir;
}

function repoWithOrigin(url: string): string {
	const dir = makeGitRepoWithOrigin(url);
	createdDirs.push(dir);
	return dir;
}

function nonGitDir(): string {
	const dir = makeTempDir("provider-detect-nonrepo-");
	createdDirs.push(dir);
	return dir;
}

describe("detectProvider — recognized URL forms resolve to github.com", () => {
	const forms: Array<[string, string]> = [
		["https://", "https://github.com/acme/widgets"],
		["https:// with trailing .git", "https://github.com/acme/widgets.git"],
		["scp-like git@host:", "git@github.com:acme/widgets.git"],
		["ssh://", "ssh://git@github.com/acme/widgets.git"],
		["ssh:// with a non-default port", "ssh://git@github.com:2222/acme/widgets.git"],
	];

	for (const [label, url] of forms) {
		test(`resolves the ${label} form (${url}) to kind "github"`, async () => {
			const result = await detectProvider(url);
			expect(result.kind).toBe("github");
			expect(result.source).toBe("host");
		});
	}
});

describe("detectProvider — recognized URL forms resolve to gitlab.com", () => {
	const forms: Array<[string, string]> = [
		["https://", "https://gitlab.com/acme/widgets"],
		["https:// with trailing .git", "https://gitlab.com/acme/widgets.git"],
		["scp-like git@host:", "git@gitlab.com:acme/widgets.git"],
	];

	for (const [label, url] of forms) {
		test(`resolves the ${label} form (${url}) to kind "gitlab"`, async () => {
			const result = await detectProvider(url);
			expect(result.kind).toBe("gitlab");
			expect(result.source).toBe("host");
		});
	}
});

describe("detectProvider — GitLab recognition on a non-gitlab.com host", () => {
	test("a URL path containing /-/merge_requests/<n> on an unrecognized host resolves to gitlab with source 'path'", async () => {
		const result = await detectProvider("https://vcs.unrecognized-host.test/team/proj/-/merge_requests/42");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("path");
	});

	test("the /-/merge_requests/ rule fires regardless of host, even one that would otherwise host-match github", async () => {
		const result = await detectProvider("https://github.com/acme/widgets/-/merge_requests/7");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("path");
	});

	test("a host listed in AI_VCS_GITLAB_HOSTS resolves to gitlab", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "git.selfhosted-example.internal";
		const result = await detectProvider("https://git.selfhosted-example.internal/acme/widgets");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("host");
	});

	test("a host NOT listed in AI_VCS_GITLAB_HOSTS is unaffected by an unrelated allowlist entry", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "some-other-gitlab-host.internal";
		await expect(detectProvider("https://git.selfhosted-example.internal/acme/widgets")).rejects.toThrow();
	});

	test("AI_VCS_GITLAB_HOSTS entries with surrounding whitespace around commas still match after trimming", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = " git.selfhosted-example.internal , another-host.internal ";
		const result = await detectProvider("https://git.selfhosted-example.internal/acme/widgets");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("host");
	});

	test("a scp-form (git@host:) remote whose host is in AI_VCS_GITLAB_HOSTS resolves to gitlab", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "git.selfhosted-example.internal";
		const result = await detectProvider("git@git.selfhosted-example.internal:acme/widgets.git");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("host");
	});
});

describe("detectProvider — host matching is case-insensitive", () => {
	test("an scp-form host with mixed case (git@GitHub.com:) still resolves to github", async () => {
		const result = await detectProvider("git@GitHub.com:acme/widgets.git");
		expect(result.kind).toBe("github");
	});

	test("an scp-form host with mixed case (git@GitLab.com:) still resolves to gitlab", async () => {
		const result = await detectProvider("git@GitLab.com:acme/widgets.git");
		expect(result.kind).toBe("gitlab");
	});

	test("an AI_VCS_GITLAB_HOSTS allowlist entry matches a differently-cased remote host", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "Git.Corp.Internal";
		const result = await detectProvider("https://git.corp.internal/acme/widgets");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("host");
	});

	test("an scp-form remote matches an allowlist entry cased differently than either side", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "Git.Selfhosted-Example.Internal";
		const result = await detectProvider("git@git.selfhosted-example.internal:acme/widgets.git");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("host");
	});
});

describe("detectProvider — malformed or non-URL remotes fail with a ProviderError, not a raw TypeError", () => {
	const malformed = ["/home/user/bare-repo.git", "../sibling.git", "github.com/acme/widgets"];

	for (const remote of malformed) {
		test(`"${remote}" throws a ProviderError with a .code, not an uncoded parse error`, async () => {
			let caught: unknown;
			try {
				await detectProvider(remote);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ProviderError);
			expect((caught as ProviderError).code).toBeDefined();
		});
	}

	test("a credential embedded in an unparseable remote is redacted from the thrown message", async () => {
		const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
		let caught: unknown;
		try {
			await detectProvider(`not-a-url-${token}`);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).message).not.toContain(token);
	});
});

describe("detectProvider — AI_VCS_PROVIDER env override", () => {
	test("an explicitly passed URL outranks the env override, so one run can resolve several hosts correctly", async () => {
		process.env.AI_VCS_PROVIDER = "gitlab";
		const result = await detectProvider("https://github.com/acme/widgets");
		expect(result.kind).toBe("github");
		expect(result.source).toBe("host");
	});

	test("the env override still covers a passed URL whose host no rule can place", async () => {
		process.env.AI_VCS_PROVIDER = "gitlab";
		const result = await detectProvider("https://vcs.unrecognized-host.test/team/proj");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("env");
	});

	test("an unrecognized passed host with no env override still throws rather than guessing", async () => {
		await expect(detectProvider("https://vcs.unrecognized-host.test/team/proj")).rejects.toThrow();
	});

	test("env override resolves without ever needing an ambient git remote (no URL given, non-git cwd)", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		process.chdir(nonGitDir());
		const result = await detectProvider();
		expect(result.kind).toBe("github");
		expect(result.source).toBe("env");
	});

	test("an unrecognized AI_VCS_PROVIDER value throws rather than falling through to host detection", async () => {
		process.env.AI_VCS_PROVIDER = "bitbucket";
		await expect(detectProvider("https://github.com/acme/widgets")).rejects.toThrow();
	});

	test("the merge_requests path rule places an unrecognized host even when the env override says otherwise", async () => {
		process.env.AI_VCS_PROVIDER = "github";
		const result = await detectProvider("https://vcs.unrecognized-host.test/team/proj/-/merge_requests/42");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("path");
	});
});

describe("detectProvider — distinct error shapes for detection failures", () => {
	test("no git repo here, no remote configured, and host not recognized each throw", async () => {
		process.chdir(nonGitDir());
		let noRepoErr: unknown;
		try {
			await detectProvider();
		} catch (e) {
			noRepoErr = e;
		}
		expect(noRepoErr).toBeInstanceOf(Error);

		process.chdir(repo());
		let noRemoteErr: unknown;
		try {
			await detectProvider();
		} catch (e) {
			noRemoteErr = e;
		}
		expect(noRemoteErr).toBeInstanceOf(Error);

		process.chdir(repoWithOrigin("https://totally-unknown-vcs-host.test/acme/widgets.git"));
		let unrecognizedHostErr: unknown;
		try {
			await detectProvider();
		} catch (e) {
			unrecognizedHostErr = e;
		}
		expect(unrecognizedHostErr).toBeInstanceOf(Error);

		const codeOf = (e: unknown): unknown => (e as { code?: unknown } | undefined)?.code;
		expect(codeOf(noRepoErr)).toBeDefined();
		expect(codeOf(noRemoteErr)).toBeDefined();
		expect(codeOf(unrecognizedHostErr)).toBeDefined();

		const codes = new Set([codeOf(noRepoErr), codeOf(noRemoteErr), codeOf(unrecognizedHostErr)]);
		expect(codes.size).toBe(3);
	});

	test("each failure scenario pins its exact discriminant code, so callers can branch on a stable string", async () => {
		process.chdir(nonGitDir());
		let noRepoErr: unknown;
		try {
			await detectProvider();
		} catch (e) {
			noRepoErr = e;
		}
		expect(noRepoErr).toBeInstanceOf(ProviderError);
		expect((noRepoErr as ProviderError).code).toBe("NO_GIT_REPO");

		process.chdir(repo());
		let noRemoteErr: unknown;
		try {
			await detectProvider();
		} catch (e) {
			noRemoteErr = e;
		}
		expect(noRemoteErr).toBeInstanceOf(ProviderError);
		expect((noRemoteErr as ProviderError).code).toBe("NO_REMOTE");

		process.chdir(repoWithOrigin("https://totally-unknown-vcs-host.test/acme/widgets.git"));
		let hostErr: unknown;
		try {
			await detectProvider();
		} catch (e) {
			hostErr = e;
		}
		expect(hostErr).toBeInstanceOf(ProviderError);
		expect((hostErr as ProviderError).code).toBe("HOST_NOT_RECOGNIZED");
	});

	test("the same failure scenario reports the same discriminant code across repeated calls (deterministic, not incidental)", async () => {
		process.chdir(repoWithOrigin("https://totally-unknown-vcs-host.test/acme/widgets.git"));
		let first: unknown;
		let second: unknown;
		try {
			await detectProvider();
		} catch (e) {
			first = (e as { code?: unknown }).code;
		}
		try {
			await detectProvider();
		} catch (e) {
			second = (e as { code?: unknown }).code;
		}
		expect(first).toBeDefined();
		expect(first).toBe(second);
	});

	test("host-not-recognized error message names the offending host (actionable, not a guess)", async () => {
		process.chdir(repoWithOrigin("https://totally-unknown-vcs-host.test/acme/widgets.git"));
		let caught: unknown;
		try {
			await detectProvider();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("totally-unknown-vcs-host.test");
	});
});

describe("detectProvider — AI_VCS_PROVIDER edge values", () => {
	test("an empty AI_VCS_PROVIDER is treated as unset and falls through to host detection", async () => {
		process.env.AI_VCS_PROVIDER = "";
		const result = await detectProvider("https://github.com/acme/widgets");
		expect(result.kind).toBe("github");
		expect(result.source).toBe("host");
	});

	test("a whitespace-only AI_VCS_PROVIDER is treated as unset and falls through to host detection", async () => {
		process.env.AI_VCS_PROVIDER = "   ";
		const result = await detectProvider("https://gitlab.com/acme/widgets");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("host");
	});

	test("a padded AI_VCS_PROVIDER value is trimmed and honored rather than rejected", async () => {
		process.env.AI_VCS_PROVIDER = "  gitlab  ";
		process.chdir(nonGitDir());
		const result = await detectProvider();
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("env");
	});

	test("a wrong-case AI_VCS_PROVIDER value throws INVALID_PROVIDER_ENV rather than being silently accepted", async () => {
		process.env.AI_VCS_PROVIDER = "GitHub";
		let caught: unknown;
		try {
			await detectProvider("https://gitlab.com/acme/widgets");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("INVALID_PROVIDER_ENV");
	});

	test("the invalid-value error names the offending value and both accepted values", async () => {
		process.env.AI_VCS_PROVIDER = "bitbucket";
		let caught: unknown;
		try {
			await detectProvider("https://github.com/acme/widgets");
		} catch (e) {
			caught = e;
		}
		const message = (caught as Error).message;
		expect(message).toContain("bitbucket");
		expect(message).toContain("github");
		expect(message).toContain("gitlab");
	});

	test("the invalid-value error code is distinct from the unrecognized-host code", async () => {
		process.env.AI_VCS_PROVIDER = "bitbucket";
		let envErr: unknown;
		try {
			await detectProvider("https://github.com/acme/widgets");
		} catch (e) {
			envErr = e;
		}
		delete process.env.AI_VCS_PROVIDER;
		let hostErr: unknown;
		try {
			await detectProvider("https://totally-unknown-vcs-host.test/acme/widgets");
		} catch (e) {
			hostErr = e;
		}
		expect((envErr as ProviderError).code).not.toBe((hostErr as ProviderError).code);
	});
});

describe("detectProvider — gitlab.com URL-form parity with the github.com form table", () => {
	const forms: Array<[string, string]> = [
		["ssh://", "ssh://git@gitlab.com/acme/widgets.git"],
		["ssh:// with a non-default port", "ssh://git@gitlab.com:2222/acme/widgets.git"],
	];

	for (const [label, url] of forms) {
		test(`resolves the ${label} form (${url}) to kind "gitlab"`, async () => {
			const result = await detectProvider(url);
			expect(result.kind).toBe("gitlab");
			expect(result.source).toBe("host");
		});
	}

	test("an allowlisted self-hosted host resolves over ssh:// with a non-default port too", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "git.selfhosted-example.internal";
		const result = await detectProvider("ssh://git@git.selfhosted-example.internal:2222/acme/widgets.git");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("host");
	});

	test("a credentialed https remote still host-matches on the hostname, not the embedded userinfo", async () => {
		const result = await detectProvider("https://oauth2:glpat-ABCDEFGHIJKLMNOPQRSTU@gitlab.com/acme/widgets.git");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("host");
	});
});

describe("detectProvider — boundaries of the /-/merge_requests/<n> path rule", () => {
	test("a /-/merge_requests path with no number does not trigger the path rule and falls back to host matching", async () => {
		let caught: unknown;
		try {
			await detectProvider("https://vcs.unrecognized-host.test/team/proj/-/merge_requests");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("HOST_NOT_RECOGNIZED");
	});

	test("a /merge_requests/<n> path missing the /-/ segment does not trigger the path rule", async () => {
		let caught: unknown;
		try {
			await detectProvider("https://vcs.unrecognized-host.test/team/proj/merge_requests/42");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("HOST_NOT_RECOGNIZED");
	});

	test("the path rule fires on an scp-form remote, not only on https URLs", async () => {
		const result = await detectProvider("git@vcs.unrecognized-host.test:team/proj/-/merge_requests/9");
		expect(result.kind).toBe("gitlab");
		expect(result.source).toBe("path");
	});
});

describe("detectProvider — degenerate AI_VCS_GITLAB_HOSTS values", () => {
	test("an allowlist of only commas and whitespace matches nothing and leaves the host unrecognized", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = " , , ";
		let caught: unknown;
		try {
			await detectProvider("https://totally-unknown-vcs-host.test/acme/widgets");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("HOST_NOT_RECOGNIZED");
	});

	test("an empty allowlist leaves the built-in github.com/gitlab.com host matching intact", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "";
		expect((await detectProvider("https://github.com/acme/widgets")).kind).toBe("github");
		expect((await detectProvider("https://gitlab.com/acme/widgets")).kind).toBe("gitlab");
	});

	test("an allowlist entry never widens matching to a host that merely contains it as a substring", async () => {
		process.env.AI_VCS_GITLAB_HOSTS = "corp.internal";
		let caught: unknown;
		try {
			await detectProvider("https://git.corp.internal/acme/widgets");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("HOST_NOT_RECOGNIZED");
	});
});

describe("detectProvider — classifies git failures by exit code, not by parsing localized stderr text", () => {
	function fakeGit(dir: string, stderrLine: string, exitCode: number): void {
		const script = [
			"#!/bin/sh",
			'if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then',
			`  echo "${stderrLine}" 1>&2`,
			`  exit ${exitCode}`,
			"fi",
			"exit 0",
		].join("\n");
		writeFakeCli(dir, "git", script);
	}

	test("a non-English 'not a git repository' stderr with exit code 128 still yields NO_GIT_REPO", async () => {
		const dir = makeTempDir("provider-detect-fakegit-norepo-");
		createdDirs.push(dir);
		fakeGit(dir, "fatal: ceci nest pas un depot git (ni aucun des repertoires parents) : .git", 128);

		let caught: unknown;
		try {
			await detectProvider();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("NO_GIT_REPO");
	});

	test("a non-English 'no such remote' stderr with exit code 2 still yields NO_REMOTE", async () => {
		const dir = makeTempDir("provider-detect-fakegit-noremote-");
		createdDirs.push(dir);
		fakeGit(dir, "Fehler: Kein Remote-Repository namens origin gefunden", 2);

		let caught: unknown;
		try {
			await detectProvider();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("NO_REMOTE");
	});
});
