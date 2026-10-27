import { describe, expect, test } from "bun:test";
import { THRASH_REVIEW_MARKER } from "../src/thrash/constants";
import { readConfig } from "../src/thrash/action/config";
import { isFork, nextRound, type Review, readEvent } from "../src/thrash/action/github";
import { compileArgs, lastJson, renderChunkTask } from "../src/thrash/action/tasks";

const PAYLOAD = {
	pull_request: {
		number: 7,
		html_url: "https://github.com/acme/app/pull/7",
		base: { sha: "abc123" },
		head: { repo: { full_name: "acme/app" } },
	},
};

describe("readConfig", () => {
	test("uses the documented defaults", () => {
		const cfg = readConfig({});
		expect(cfg).toMatchObject({
			spice: 2,
			reviewRules: "docs/code_review.md",
			policy: ".github/thrashley.yml",
			verdict: "auto",
			backend: "copilot",
			heading: "Code Review",
			botLogin: "github-actions[bot]",
			sass: false,
			failOnRequestChanges: true,
		});
		expect(cfg.maxComments).toBeUndefined();
	});

	test("rejects a bad spice, verdict or flag", () => {
		expect(() => readConfig({ THRASHLEY_SPICE: "6" })).toThrow("spice");
		expect(() => readConfig({ THRASHLEY_VERDICT: "reject" })).toThrow(
			"verdict",
		);
		expect(() => readConfig({ THRASHLEY_SASS: "yes" })).toThrow("sass");
	});

	test("refuses a backend with shell tools unless the caller opts in", () => {
		expect(() => readConfig({ THRASHLEY_BACKEND: "codex" })).toThrow(
			"unsafe-allow-shell",
		);
		expect(
			readConfig({
				THRASHLEY_BACKEND: "codex",
				THRASHLEY_UNSAFE_ALLOW_SHELL: "true",
			}).backend,
		).toBe("codex");
	});
});

describe("pull request event", () => {
	test("reads the PR and spots a fork", () => {
		const event = readEvent(PAYLOAD, "acme/app");
		expect(event).toEqual({
			repo: "acme/app",
			number: 7,
			url: "https://github.com/acme/app/pull/7",
			baseSha: "abc123",
			headRepo: "acme/app",
		});
		expect(isFork(event)).toBe(false);
		expect(isFork({ ...event, headRepo: "someone/app" })).toBe(true);
	});

	test("refuses a non pull_request event", () => {
		expect(() => readEvent({ push: {} }, "acme/app")).toThrow(
			"pull_request events only",
		);
	});
});

describe("nextRound", () => {
	const own = (state: string): Review => ({
		user: { login: "thrashley[bot]" },
		body: `## Code Review\n${THRASH_REVIEW_MARKER}`,
		state,
	});

	test("counts this bot's submitted and dismissed reviews, not pending ones or other reviewers", () => {
		const reviews: Review[] = [
			own("CHANGES_REQUESTED"),
			own("DISMISSED"),
			own("PENDING"),
			{
				user: { login: "copilot-pull-request-reviewer[bot]" },
				body: THRASH_REVIEW_MARKER,
				state: "COMMENTED",
			},
			{
				user: { login: "thrashley[bot]" },
				body: "a manual note",
				state: "COMMENTED",
			},
		];
		expect(nextRound(reviews, "thrashley")).toBe(3);
		expect(nextRound([], "thrashley[bot]")).toBe(1);
	});
});

describe("renderChunkTask", () => {
	const chunk = {
		id: 1,
		label: "src",
		annotatedPath: "/s/a.diff",
		findingsPath: "/s/a.findings.md",
	};

	test("adds the review rules and extra instructions", () => {
		const task = renderChunkTask({
			chunk,
			chunkCount: 2,
			contextPath: "/s/ctx.md",
			spice: 3,
			target: "https://github.com/acme/app/pull/7",
			rulesPath: "/s/review-rules.md",
			extraPrompt: "Check the SQL migrations twice.",
		});
		expect(task).toContain("REVIEW_RULES: /s/review-rules.md");
		expect(task).toContain(
			"Open only ANNOTATED_DIFF, CONTEXT and REVIEW_RULES.",
		);
		expect(task).toContain("Ignore its verdict");
		expect(task).toContain("CHUNK: 1 of 2");
		expect(task.trimEnd().endsWith("Check the SQL migrations twice.")).toBe(
			true,
		);
	});

	test("leaves the rules lines out when the repo has none", () => {
		const task = renderChunkTask({
			chunk,
			chunkCount: 1,
			contextPath: "/s/ctx.md",
			spice: 2,
			target: "t",
			rulesPath: null,
			extraPrompt: null,
		});
		expect(task).not.toContain("REVIEW_RULES");
		expect(task).toContain("Open only ANNOTATED_DIFF and CONTEXT.");
	});
});

describe("compileArgs", () => {
	test("passes round, heading, verdict cap and reviewer, and optional flags only when set", () => {
		const base = {
			target: "u",
			diffPath: "/d",
			spice: 2,
			heading: "Code Review",
			round: 4,
			policyPath: null,
			verdict: "auto",
			reviewer: "thrashley[bot]",
			sass: false,
		};
		const args = compileArgs(base);
		expect(args.slice(0, 4)).toEqual(["thrash", "compile", "u", "--json"]);
		expect(args).toContain("--round");
		expect(args).not.toContain("--policy");
		expect(args).not.toContain("--sass");
		const full = compileArgs({
			...base,
			policyPath: "/p.yml",
			maxComments: 10,
			sass: true,
		});
		expect(full.slice(-5)).toEqual([
			"--policy",
			"/p.yml",
			"--max-comments",
			"10",
			"--sass",
		]);
	});
});

describe("lastJson", () => {
	test("reads the final JSON object after log lines", () => {
		expect(lastJson<{ a: number }>('progress\n{\n  "a": 1\n}\n')).toEqual({
			a: 1,
		});
		expect(() => lastJson("no json here")).toThrow("no JSON");
	});
});
