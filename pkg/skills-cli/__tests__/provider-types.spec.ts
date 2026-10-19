import { describe, expect, test } from "bun:test";

import {
	FIELD_MAP,
	GITLAB_STATE_TO_PR_STATE,
	LOG_EXCERPT_MAX_CHARS,
	normalizeIssueStateFilter,
	normalizePrStateFilter,
	notSupportedMessage,
	ProviderError,
	parsePrNumberArg,
	parseRepoRef,
	truncateLogExcerpt,
} from "../src/provider/types";

describe("parseRepoRef", () => {
	test("parses an https:// GitHub URL into host/owner/repo", () => {
		expect(parseRepoRef("https://github.com/acme/widgets")).toEqual({
			host: "github.com",
			owner: "acme",
			repo: "widgets",
		});
	});

	test("strips a trailing .git suffix", () => {
		expect(parseRepoRef("https://github.com/acme/widgets.git")).toEqual({
			host: "github.com",
			owner: "acme",
			repo: "widgets",
		});
	});

	test("a GitLab nested-subgroup path becomes a slash-joined owner", () => {
		expect(parseRepoRef("https://gitlab.com/group/subgroup/project")).toEqual({
			host: "gitlab.com",
			owner: "group/subgroup",
			repo: "project",
		});
	});

	test("parses the scp-like git@host: form", () => {
		expect(parseRepoRef("git@github.com:acme/widgets.git")).toEqual({
			host: "github.com",
			owner: "acme",
			repo: "widgets",
		});
	});

	test("strips a trailing slash that follows a .git suffix, not just a bare trailing slash", () => {
		expect(parseRepoRef("https://gitlab.corp.test/g/s/p.git/")).toEqual({
			host: "gitlab.corp.test",
			owner: "g/s",
			repo: "p",
		});
	});

	test("strips a trailing slash after .git on the scp-like form too", () => {
		expect(parseRepoRef("git@gitlab.corp.test:g/s/p.git/")).toEqual({
			host: "gitlab.corp.test",
			owner: "g/s",
			repo: "p",
		});
	});

	test("lowercases the host on the scp-like form the same way the URL form does", () => {
		expect(parseRepoRef("git@GitHub.com:acme/widgets.git")).toEqual({
			host: "github.com",
			owner: "acme",
			repo: "widgets",
		});
	});

	test("a bare owner/repo slug with no host yields an empty host", () => {
		expect(parseRepoRef("acme/widgets")).toEqual({ host: "", owner: "acme", repo: "widgets" });
	});

	test("throws a ProviderError when there is no owner/repo to extract", () => {
		expect(() => parseRepoRef("https://github.com/widgets")).toThrow(ProviderError);
	});

	test("drops a non-default ssh port from the host instead of folding it into the hostname", () => {
		expect(parseRepoRef("ssh://git@gitlab.corp.test:2222/group/subgroup/project.git")).toEqual({
			host: "gitlab.corp.test",
			owner: "group/subgroup",
			repo: "project",
		});
	});

	test("keeps the port of an https URL so a self-hosted instance is reached on it", () => {
		expect(parseRepoRef("https://git.example.com:8443/group/repo")).toEqual({
			host: "git.example.com:8443",
			owner: "group",
			repo: "repo",
		});
	});

	test("an unparseable URL raises INVALID_REPO_REF without echoing userinfo tokens", () => {
		let caught: unknown;
		try {
			parseRepoRef("https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@:bad/group/repo");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("INVALID_REPO_REF");
		expect((caught as ProviderError).message).not.toContain("ghp_abcdefghij");
	});

	test("a deeply nested scp-like path keeps every intermediate segment in owner", () => {
		expect(parseRepoRef("git@gitlab.corp.test:a/b/c/d.git")).toEqual({
			host: "gitlab.corp.test",
			owner: "a/b/c",
			repo: "d",
		});
	});

	test("collapses repeated trailing slashes rather than emitting an empty repo segment", () => {
		expect(parseRepoRef("https://github.com/acme/widgets///")).toEqual({
			host: "github.com",
			owner: "acme",
			repo: "widgets",
		});
	});

	test("a credentialed https URL yields the hostname, keeping the userinfo out of host and owner", () => {
		const secret = `glpat-${"A".repeat(20)}`;
		const ref = parseRepoRef(`https://oauth2:${secret}@gitlab.com/acme/widgets.git`);
		expect(ref).toEqual({ host: "gitlab.com", owner: "acme", repo: "widgets" });
	});

	test("a single-segment bare slug throws with the INVALID_REPO_REF discriminant, not a bare Error", () => {
		let caught: unknown;
		try {
			parseRepoRef("widgets");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("INVALID_REPO_REF");
	});

	test("a token embedded in an unparseable input is redacted from the thrown ProviderError's message", () => {
		const token = `ghp_${"A".repeat(36)}`;
		let caught: unknown;
		try {
			parseRepoRef(`https://x-access-token:${token}@github.com/onlyowner`);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as Error).message).not.toContain(token);
	});
});

describe("truncateLogExcerpt", () => {
	test("leaves text at or under the max length unchanged", () => {
		const text = "x".repeat(LOG_EXCERPT_MAX_CHARS);
		expect(truncateLogExcerpt(text)).toBe(text);
	});

	test("truncates text over the max length down to exactly the max length", () => {
		const text = "y".repeat(LOG_EXCERPT_MAX_CHARS + 500);
		const result = truncateLogExcerpt(text);
		expect(result.length).toBe(LOG_EXCERPT_MAX_CHARS);
	});

	test("one char over the max drops exactly the first char", () => {
		const text = `H${"c".repeat(LOG_EXCERPT_MAX_CHARS)}`;
		const result = truncateLogExcerpt(text);
		expect(result.length).toBe(LOG_EXCERPT_MAX_CHARS);
		expect(result).toBe(text.slice(1));
	});

	test("an empty log excerpt is returned unchanged rather than throwing", () => {
		expect(truncateLogExcerpt("")).toBe("");
	});

	test("keeps the tail of the log, not the head, since the failure detail lives near the end", () => {
		const head = "a".repeat(1000);
		const tail = "b".repeat(LOG_EXCERPT_MAX_CHARS);
		const result = truncateLogExcerpt(head + tail);
		expect(result).toBe(tail);
		expect(result).not.toContain("a");
	});
});

describe("ProviderError", () => {
	test("carries a machine-readable code discriminant distinct from .message", () => {
		const err = new ProviderError("PARSE_ERROR", "human readable explanation");
		expect(err.code).toBe("PARSE_ERROR");
		expect(err.message).toBe("human readable explanation");
		expect(err).toBeInstanceOf(Error);
	});
});

describe("notSupportedMessage", () => {
	test("names the unsupported feature in the returned message", () => {
		expect(notSupportedMessage("native stacking")).toContain("native stacking");
	});
});

describe("GITLAB_STATE_TO_PR_STATE", () => {
	test("maps GitLab's opened/closed/merged states onto the normalized OPEN/CLOSED/MERGED vocabulary", () => {
		expect(GITLAB_STATE_TO_PR_STATE.opened).toBe("OPEN");
		expect(GITLAB_STATE_TO_PR_STATE.closed).toBe("CLOSED");
		expect(GITLAB_STATE_TO_PR_STATE.merged).toBe("MERGED");
	});

	test("folds GitLab's 'locked' state to CLOSED rather than leaving it unmapped", () => {
		expect(GITLAB_STATE_TO_PR_STATE.locked).toBe("CLOSED");
	});

	test("carries exactly the four known GitLab state keys, each a valid PrState value", () => {
		const validStates = new Set(["OPEN", "CLOSED", "MERGED"]);
		expect(Object.keys(GITLAB_STATE_TO_PR_STATE).sort()).toEqual(["closed", "locked", "merged", "opened"]);
		for (const value of Object.values(GITLAB_STATE_TO_PR_STATE)) {
			expect(validStates.has(value)).toBe(true);
		}
	});
});

describe("FIELD_MAP", () => {
	test("maps the normalized PullRequest DTO's headRefName/baseRefName/mergedAt to their gh and glab source field names", () => {
		expect(FIELD_MAP.headRefName).toEqual({ github: "headRefName", gitlab: "source_branch" });
		expect(FIELD_MAP.baseRefName).toEqual({ github: "baseRefName", gitlab: "target_branch" });
		expect(FIELD_MAP.mergedAt).toEqual({ github: "mergedAt", gitlab: "merged_at" });
	});
});

describe("state filters and numeric arguments", () => {
	test("an inherited object key is not a valid pull request state", () => {
		expect(() => normalizePrStateFilter("constructor")).toThrow(ProviderError);
	});

	test("an inherited object key is not a valid issue state", () => {
		expect(() => normalizeIssueStateFilter("constructor")).toThrow(ProviderError);
	});

	test.each(["1e3", "0x10", "1.5", "-4", " 7"])("parsePrNumberArg rejects %s", (arg) => {
		expect(() => parsePrNumberArg(arg)).toThrow(ProviderError);
	});

	test("parsePrNumberArg still accepts a plain number and a URL", () => {
		expect(parsePrNumberArg("42")).toBe(42);
		expect(parsePrNumberArg("https://github.com/acme/widgets/pull/17")).toBe(17);
	});
});
