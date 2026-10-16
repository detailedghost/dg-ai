import { describe, expect, test } from "bun:test";
import { createRepoClient, parseRepo, repoKey } from "../src/automation/repos";
import { createFakeCapture } from "./support/fakes";

const REPO = { host: "github.com", owner: "example-org", repo: "app" };

describe("parseRepo", () => {
	test("parses host/owner/repo and lowercases the host", () => {
		expect(parseRepo("GitHub.com/example-org/app")).toEqual(REPO);
		expect(repoKey(REPO)).toBe("github.com/example-org/app");
	});

	test("accepts a configured enterprise host", () => {
		expect(parseRepo("ghe.example.com/o/r", ["github.com", "ghe.example.com"]).host).toBe("ghe.example.com");
	});

	test("names the host when it is not GitHub", () => {
		expect(() => parseRepo("gitlab.example.com/o/r")).toThrow("gitlab.example.com is not a GitHub host");
	});

	test.each(["o/r", "github.com/o", "github.com/o/r/x", "github.com//r", "github.com/o/r r"])(
		"rejects %s",
		(value) => {
			expect(() => parseRepo(value)).toThrow();
		},
	);
});

describe("createRepoClient", () => {
	test("reads the default branch through gh api", async () => {
		const fake = createFakeCapture(() => ({ status: 0, stdout: "main\n" }));
		await expect(createRepoClient(fake.runner).defaultBranch(REPO)).resolves.toBe("main");
		expect(fake.calls).toEqual([
			{ command: "gh", args: ["api", "repos/example-org/app", "--jq", ".default_branch"] },
		]);
	});

	test("targets an enterprise host with --hostname", async () => {
		const fake = createFakeCapture(() => ({ status: 0, stdout: "trunk" }));
		await createRepoClient(fake.runner).defaultBranch({ ...REPO, host: "ghe.example.com" });
		expect(fake.calls[0]?.args.slice(0, 3)).toEqual(["api", "--hostname", "ghe.example.com"]);
	});

	test("fails with the gh error when the call fails", async () => {
		const fake = createFakeCapture(() => ({ status: 1, stderr: "HTTP 404" }));
		await expect(createRepoClient(fake.runner).defaultBranch(REPO)).rejects.toThrow("HTTP 404");
	});

	test("fails when gh is missing", async () => {
		const runner = (async () => {
			throw Object.assign(new Error("spawn gh"), { code: "ENOENT" });
		}) as never;
		await expect(createRepoClient(runner).defaultBranch(REPO)).rejects.toThrow("gh is not installed");
	});

	test("lists open PRs with the expected gh arguments", async () => {
		const rows = [
			{
				url: "https://github.com/example-org/app/pull/3",
				headRefName: "bot/fix/x",
				isDraft: true,
				createdAt: "2026-10-14T10:00:00Z",
			},
		];
		const fake = createFakeCapture(() => ({ status: 0, stdout: JSON.stringify(rows) }));
		await expect(createRepoClient(fake.runner).openPrs(REPO)).resolves.toEqual(rows);
		expect(fake.calls[0]).toEqual({
			command: "gh",
			args: [
				"pr",
				"list",
				"--repo",
				"github.com/example-org/app",
				"--state",
				"open",
				"--limit",
				"100",
				"--json",
				"url,headRefName,isDraft,createdAt",
			],
		});
	});

	test("rejects malformed PR JSON", async () => {
		const fake = createFakeCapture(() => ({ status: 0, stdout: "{}" }));
		await expect(createRepoClient(fake.runner).openPrs(REPO)).rejects.toThrow("malformed JSON");
	});
});
