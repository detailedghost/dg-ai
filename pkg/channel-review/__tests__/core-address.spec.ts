import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAddressWorkspace,
	insideRoot,
	removeCloneDir,
	removeLeftoverClones,
} from "../src/address";
import type { CaptureFn } from "../src/verdict/cli";
import { VerdictError } from "../src/verdict/types";
import { createRecordedLog } from "./support/fakes";

const dirs: string[] = [];
function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "address-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

type Call = { command: string; args: string[] };

function capture(
	reply: (call: Call) => { status: number; stdout?: string; stderr?: string },
) {
	const calls: Call[] = [];
	const runner = (async (command: string, args: string[]) => {
		calls.push({ command, args });
		const { status, stdout = "", stderr = "" } = reply({ command, args });
		return { status, signal: null, stdout, stderr };
	}) as CaptureFn;
	return { calls, runner };
}

const GITHUB = "https://github.com/Org/Repo/pull/7";
const GHE = "https://ghe.example.com/org/repo/pull/7";
const GITLAB = "https://gitlab.example.com/group/sub/proj/-/merge_requests/3";

describe("address workspace head", () => {
	test("reads the GitHub head branch and flags same-repo PRs as not forks", async () => {
		const { calls, runner } = capture(() => ({
			status: 0,
			stdout: JSON.stringify({
				head: { ref: "feature/x", repo: { full_name: "org/repo" } },
				base: { repo: { full_name: "Org/Repo" } },
			}),
		}));
		const head = await createAddressWorkspace(runner).head({
			url: GITHUB,
			host: "github",
		});
		expect(head).toEqual({
			name: "github.com-Org-Repo",
			branch: "feature/x",
			fork: false,
		});
		expect(calls[0]).toEqual({
			command: "gh",
			args: ["api", "--hostname", "github.com", "repos/Org/Repo/pulls/7"],
		});
	});

	test.each([
		["a fork", { full_name: "someone/repo" }],
		["a deleted fork", null],
	])("flags %s", async (_name, repo) => {
		const { runner } = capture(() => ({
			status: 0,
			stdout: JSON.stringify({
				head: { ref: "x", repo },
				base: { repo: { full_name: "org/repo" } },
			}),
		}));
		const head = await createAddressWorkspace(runner).head({
			url: GHE,
			host: "github",
		});
		expect(head.fork).toBe(true);
	});

	test("reads the GitLab source branch and compares the projects", async () => {
		const { calls, runner } = capture(() => ({
			status: 0,
			stdout: JSON.stringify({
				source_branch: "fix",
				source_project_id: 4,
				target_project_id: 4,
			}),
		}));
		const head = await createAddressWorkspace(runner).head({
			url: GITLAB,
			host: "gitlab",
		});
		expect(head).toEqual({
			name: "gitlab.example.com-group-sub-proj",
			branch: "fix",
			fork: false,
		});
		expect(calls[0]?.args.at(-1)).toBe(
			"projects/group%2Fsub%2Fproj/merge_requests/3",
		);
	});

	test("maps a 404 to CR-302", async () => {
		const { runner } = capture(() => ({
			status: 1,
			stderr: "HTTP 404: Not Found",
		}));
		const error = await createAddressWorkspace(runner)
			.head({ url: GITHUB, host: "github" })
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(VerdictError);
		expect((error as VerdictError).code).toBe("CR-302");
	});
});

describe("address workspace clone", () => {
	test("clones one GitHub branch through gh with the host in the repo name", async () => {
		const { calls, runner } = capture(() => ({ status: 0 }));
		await createAddressWorkspace(runner).clone({
			url: GHE,
			host: "github",
			branch: "b",
			dir: "/c/d",
		});
		expect(calls).toEqual([
			{
				command: "gh",
				args: [
					"repo",
					"clone",
					"ghe.example.com/org/repo",
					"/c/d",
					"--",
					"--branch",
					"b",
					"--single-branch",
				],
			},
		]);
	});

	test("clones one GitLab branch through glab from the project URL", async () => {
		const { calls, runner } = capture(() => ({ status: 0 }));
		await createAddressWorkspace(runner).clone({
			url: GITLAB,
			host: "gitlab",
			branch: "b",
			dir: "/c/d",
		});
		expect(calls[0]).toEqual({
			command: "glab",
			args: [
				"repo",
				"clone",
				"https://gitlab.example.com/group/sub/proj",
				"/c/d",
				"--",
				"--branch",
				"b",
				"--single-branch",
			],
		});
	});

	test("maps a failed clone to CR-306", async () => {
		const { runner } = capture(() => ({
			status: 128,
			stderr: "Remote branch b not found",
		}));
		const error = await createAddressWorkspace(runner)
			.clone({ url: GITHUB, host: "github", branch: "b", dir: "/c/d" })
			.catch((err: unknown) => err);
		expect((error as VerdictError).code).toBe("CR-306");
	});
});

describe("clone directory delete guard", () => {
	test("accepts only paths strictly inside the root", () => {
		expect(insideRoot("/a/root", "/a/root/x")).toBe(true);
		expect(insideRoot("/a/root", "/a/root")).toBe(false);
		expect(insideRoot("/a/root", "/a/root/")).toBe(false);
		expect(insideRoot("/a/root", "/a/root/../other")).toBe(false);
		expect(insideRoot("/a/root", "/a/rootless/x")).toBe(false);
	});

	test("deletes a job directory inside the root", () => {
		const root = tempRoot();
		const dir = join(root, "github.com-o-r-m1");
		mkdirSync(join(dir, "src"), { recursive: true });
		removeCloneDir(root, dir, createRecordedLog());
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(root)).toBe(true);
	});

	test("refuses the root itself and a path outside it", () => {
		const root = join(tempRoot(), "root");
		const outside = join(root, "..", "outside");
		mkdirSync(root, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const log = createRecordedLog();
		removeCloneDir(root, root, log);
		removeCloneDir(root, outside, log);
		expect(existsSync(root)).toBe(true);
		expect(existsSync(outside)).toBe(true);
		expect(log.lines.filter((line) => line.level === "warn")).toHaveLength(2);
	});

	test("removes only leftover clones whose name ends with an interrupted message id", () => {
		const root = tempRoot();
		for (const name of ["h-o-r-m1", "h-o-r-m10", "h-o-r-m2"])
			mkdirSync(join(root, name));
		removeLeftoverClones(root, ["m1"], createRecordedLog());
		expect(existsSync(join(root, "h-o-r-m1"))).toBe(false);
		expect(existsSync(join(root, "h-o-r-m10"))).toBe(true);
		expect(existsSync(join(root, "h-o-r-m2"))).toBe(true);
	});

	test("ignores a missing clone root", () => {
		expect(() =>
			removeLeftoverClones("/does/not/exist", ["m1"], createRecordedLog()),
		).not.toThrow();
	});
});
