import { describe, expect, test } from "bun:test";
import type { Provider } from "../../src/provider/types";
import {
	type AttachPrDeps,
	describeAttachPrOutcome,
	parsePrRefArg,
	resolveAttachPr,
} from "../../src/demo/attach-pr";

function stubProvider(viewPullRequest: Provider["viewPullRequest"]): Provider {
	return { viewPullRequest } as unknown as Provider;
}

describe("parsePrRefArg", () => {
	test("accepts a bare PR number", () => {
		expect(parsePrRefArg("83")).toEqual({ number: 83 });
	});

	test("accepts a GitHub PR URL", () => {
		expect(parsePrRefArg("https://github.com/acme/widgets/pull/83")).toEqual({
			number: 83,
		});
	});

	test("accepts a GitLab MR URL", () => {
		expect(
			parsePrRefArg("https://gitlab.com/acme/widgets/-/merge_requests/83"),
		).toEqual({ number: 83 });
	});

	test("rejects anything else", () => {
		expect(() => parsePrRefArg("feature/my-branch")).toThrow();
	});
});

describe("resolveAttachPr", () => {
	test("refuses GitLab before calling the provider at all, with no mutation", async () => {
		let providerCalled = false;
		const deps: AttachPrDeps = {
			detect: async () => ({ kind: "gitlab", source: "host" }),
			getProvider: async () => {
				providerCalled = true;
				throw new Error("must not be called for gitlab");
			},
		};
		const outcome = await resolveAttachPr("83", ["video.webm"], deps);
		expect(outcome).toEqual({ kind: "gitlab-unsupported" });
		expect(providerCalled).toBe(false);
	});

	test("hands the files and PR link back for GitHub, with no saved-login upload path yet", async () => {
		const deps: AttachPrDeps = {
			detect: async () => ({ kind: "github", source: "host" }),
			getProvider: async () =>
				stubProvider(async (ref) => {
					expect(ref).toEqual({ number: 83 });
					return {
						number: 83,
						title: "Demo PR",
						url: "https://github.com/acme/widgets/pull/83",
						state: "OPEN",
						headRefName: "feature/demo",
						baseRefName: "main",
						body: "body",
						mergedAt: null,
						merged: false,
					};
				}),
		};
		const outcome = await resolveAttachPr(
			"83",
			["before-light.png", "after-light.png"],
			deps,
		);
		expect(outcome).toEqual({
			kind: "no-login-handoff",
			prUrl: "https://github.com/acme/widgets/pull/83",
			files: ["before-light.png", "after-light.png"],
		});
	});
});

describe("describeAttachPrOutcome", () => {
	test("names GitLab as unsupported and states the PR is unchanged", () => {
		const message = describeAttachPrOutcome({ kind: "gitlab-unsupported" });
		expect(message).toContain("GitLab");
		expect(message).toContain("not changed");
	});

	test("defers to 'once recorded' wording when no files exist yet (--ext mode)", () => {
		const message = describeAttachPrOutcome({
			kind: "no-login-handoff",
			prUrl: "https://github.com/acme/widgets/pull/83",
			files: [],
		});
		expect(message).toContain("Once you've recorded");
		expect(message).toContain("https://github.com/acme/widgets/pull/83");
		expect(message).toContain("not changed");
	});

	test("lists every file and the PR link for a hand-off", () => {
		const message = describeAttachPrOutcome({
			kind: "no-login-handoff",
			prUrl: "https://github.com/acme/widgets/pull/83",
			files: ["a.png", "b.webm"],
		});
		expect(message).toContain("https://github.com/acme/widgets/pull/83");
		expect(message).toContain("a.png");
		expect(message).toContain("b.webm");
		expect(message).toContain("not changed");
	});
});
