import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isReleaseCommit } from "../../../scripts/release-version";
import { SUPPORTED_PLATFORMS } from "./supported-platforms";
import {
	createStepSandbox,
	findStep,
	jobNeeds,
	parseWorkflow,
	type StepSandbox,
	type WorkflowJob,
	stepText,
	workflowFiles,
	workflowText,
} from "./workflow-support";

const STEP = {
	tag: "Look for an existing tag",
	stale: "Refuse to cut a release from a stale commit",
	tagged: "Check out the tagged release commit",
	stamp: "Stamp the release version",
	changelog: "Write the changelog entry",
	commit: "Commit the release as dg-release",
	push: "Push the release commit and tag together",
	notes: "Extract the release notes from the changelog",
	assets: "Add the bootstrap scripts and checksums",
	publish: "Publish the release",
	latest: "Move the latest tag to the release commit",
} as const;

const BUILD_JOBS = ["build-bundle", "build-ext"];
const BOT = "dg-release";
const BOT_EMAIL = "dante+release@detailedghost.com";

const text = workflowText("release.yml");
const workflow = parseWorkflow("release.yml");
const releaseJob = workflow.jobs.release;
const step = (name: string) => findStep(releaseJob, name);

function grantsWrite(source: string): boolean {
	return /\bcontents:\s*write\b|\bwrite-all\b/.test(source);
}

function forkReachable(source: string): boolean {
	return /\b(pull_request_target|issue_comment|workflow_run)\b/.test(source);
}

function withSandbox(body: (sandbox: StepSandbox) => void): void {
	const sandbox = createStepSandbox();
	try {
		body(sandbox);
	} finally {
		sandbox.cleanup();
	}
}

function ghCalls(sandbox: StepSandbox): string[] {
	return readFileSync(sandbox.ghLog, "utf8").split("\n").filter(Boolean);
}

describe("only the release job can write to the repository", () => {
	test("the workflow grants read access by default", () => {
		expect(workflow.permissions).toEqual({ contents: "read" });
	});

	test("the release job is the only job with contents: write", () => {
		expect(releaseJob.permissions).toEqual({ contents: "write" });
		for (const [id, job] of Object.entries(workflow.jobs)) {
			if (id === "release") continue;
			expect([id, job.permissions ?? { contents: "read" }]).toEqual([
				id,
				{ contents: "read" },
			]);
		}
		expect(text.match(/:\s*write\b/g)?.length).toBe(1);
		expect(text).not.toContain("write-all");
	});

	test("the release job runs no install, so no dependency script sees the write token", () => {
		const commands = (releaseJob.steps ?? [])
			.map((s) => s.run ?? "")
			.join("\n");

		expect(commands).not.toContain("bun install");
		expect(commands).not.toContain("npm ");
	});
});

describe("no workflow hands a write token to a fork-reachable trigger", () => {
	test("the guard flags each risky combination and passes a safe one", () => {
		const write = "permissions:\n  contents: write\n";

		expect(
			grantsWrite(write) &&
				forkReachable(`on:\n  pull_request_target:\n${write}`),
		).toBe(true);
		expect(
			grantsWrite(write) && forkReachable(`on:\n  issue_comment:\n${write}`),
		).toBe(true);
		expect(
			grantsWrite(write) && forkReachable(`on:\n  workflow_run:\n${write}`),
		).toBe(true);
		expect(
			grantsWrite("permissions: write-all") &&
				forkReachable("on: workflow_run"),
		).toBe(true);
		expect(grantsWrite(write) && forkReachable("on:\n  push:\n")).toBe(false);
		expect(grantsWrite("permissions:\n  contents: read\n")).toBe(false);
	});

	for (const name of workflowFiles()) {
		test(`${name} does not combine contents: write with pull_request_target, issue_comment or workflow_run`, () => {
			const source = workflowText(name);

			expect(grantsWrite(source) && forkReachable(source)).toBe(false);
		});
	}
});

describe("every workflow is valid YAML and pins every action by commit", () => {
	for (const name of workflowFiles()) {
		test(`${name} parses and pins each external action to a full sha with a version comment`, () => {
			expect(() => parseWorkflow(name)).not.toThrow();

			const uses = workflowText(name)
				.split("\n")
				.filter((line) => /^\s*(- )?uses:/.test(line))
				.filter((line) => !/uses:\s*\.\//.test(line));
			for (const line of uses) {
				expect(line).toMatch(/uses:\s*\S+@[0-9a-f]{40} # v\d/);
			}
		});
	}
});

describe("the release job pushes with the deploy key that bypasses the master ruleset", () => {
	test("only the release job checks out with RELEASE_DEPLOY_KEY", () => {
		const workflow = parseWorkflow("release.yml");
		const users = Object.entries(workflow.jobs)
			.filter(([, job]) =>
				(job.steps ?? []).some((s) => JSON.stringify(s.with ?? {}).includes("RELEASE_DEPLOY_KEY")),
			)
			.map(([id]) => id);
		expect(users).toEqual(["release"]);
		const checkout = (workflow.jobs.release.steps ?? []).find((s) =>
			String(s.uses ?? "").startsWith("actions/checkout@"),
		);
		expect(checkout?.with?.["ssh-key"]).toBe("${{ secrets.RELEASE_DEPLOY_KEY }}");
		expect(checkout?.with?.["persist-credentials"]).toBe(true);
	});
});

describe("the release workflow changes no repository settings", () => {
	test("it never touches rulesets, branch protection or repo settings", () => {
		expect(text).not.toContain("rulesets");
		expect(text).not.toContain("protection");
		expect(text).not.toContain("gh repo edit");
	});
});

describe("every part is stamped with the release version before it is built", () => {
	for (const id of BUILD_JOBS) {
		test(`${id} stamps the version, then installs`, () => {
			const steps = workflow.jobs[id].steps ?? [];
			const stampAt = steps.findIndex((s) => s.name === STEP.stamp);
			const installAt = steps.findIndex((s) => /bun install/.test(s.run ?? ""));

			expect(stampAt).toBeGreaterThan(-1);
			expect(installAt).toBeGreaterThan(stampAt);
			expect(steps[stampAt].run).toContain(
				"scripts/release-version.ts stamp --version",
			);
			expect(steps[stampAt].env?.VERSION).toBe(
				"${{ needs.detect.outputs.version }}",
			);
		});
	}

	test("the release job stamps the same way before it commits", () => {
		expect(step(STEP.stamp).run).toContain(
			"scripts/release-version.ts stamp --version",
		);
	});

	test("the extension build ships both browser zips under the stamped version", () => {
		const upload = (workflow.jobs["build-ext"].steps ?? []).find((s) =>
			s.uses?.startsWith("actions/upload-artifact@"),
		);
		const paths = String(upload?.with?.path);

		expect(paths).toContain(
			"dg-ai-extension-${{ needs.detect.outputs.version }}-chrome.zip",
		);
		expect(paths).toContain(
			"dg-ai-extension-${{ needs.detect.outputs.version }}-firefox.zip",
		);
	});
});

describe("the release is cut in one fixed order and recovers only forward", () => {
	test("detect, stale check, stamp, changelog, commit, push, notes, assets, publish, latest", () => {
		const names = (releaseJob.steps ?? []).map((s) => s.name);
		const order = [
			STEP.tag,
			STEP.stale,
			STEP.stamp,
			STEP.changelog,
			STEP.commit,
			STEP.push,
			STEP.notes,
			STEP.assets,
			STEP.publish,
			STEP.latest,
		].map((name) => names.indexOf(name));

		expect(order.every((at) => at > -1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("the steps that write a commit run only when the tag is new", () => {
		for (const name of [
			STEP.stale,
			STEP.stamp,
			STEP.changelog,
			STEP.commit,
			STEP.push,
		]) {
			expect(step(name).if).toBe("steps.tag.outputs.exists == 'false'");
		}
		expect(step(STEP.tagged).if).toBe("steps.tag.outputs.exists == 'true'");
	});

	test("the changelog and the notes read the commits since the previous release, not the stamped version", () => {
		expect(step(STEP.changelog).run).toContain('--from "$PREVIOUS_TAG"');
		expect(releaseJob.env?.PREVIOUS_TAG).toBe(
			"${{ needs.detect.outputs.previous_tag }}",
		);
	});

	test("the commit and the tag land on master in one atomic push, never forced", () => {
		expect(step(STEP.push).run).toContain(
			'git push --atomic origin HEAD:master "refs/tags/${TAG}"',
		);
	});

	test("no git push is forced except the move of the latest tag", () => {
		const pushes = text.split("\n").filter((line) => /git push/.test(line));

		expect(pushes.length).toBeGreaterThanOrEqual(2);
		for (const line of pushes) {
			expect(line).not.toMatch(/--force|\s-f\b|--mirror|--delete/);
			if (line.includes("+")) expect(line).toContain(":refs/tags/latest");
		}
		expect(text).not.toMatch(/git (tag|branch) .*(-f\b|--force)/);
	});

	test("no step deletes a tag", () => {
		expect(text).not.toContain("--cleanup-tag");
		expect(text).not.toMatch(/git tag (-d|--delete)/);
		expect(text).not.toMatch(/git push [^\n]*(--delete|\s:refs\/)/);
		expect(text).not.toContain("git/refs/tags");
		for (const line of text.split("\n").filter((l) => l.includes("DELETE"))) {
			expect(line).toContain("/releases/");
		}
	});

	test("the release is created as a draft, then published and marked latest in one call", () => {
		const publish = step(STEP.publish).run ?? "";
		const create = publish.indexOf("gh release create");
		const edit = publish.indexOf(
			'gh release edit "$TAG" --draft=false --latest',
		);

		expect(publish).toContain("--draft");
		expect(create).toBeGreaterThan(-1);
		expect(edit).toBeGreaterThan(create);
	});

	test("the release commit message matches the loop guard", () => {
		const message = /--message "(chore\(release\): cut \$\{VERSION\})"/.exec(
			step(STEP.commit).run ?? "",
		)?.[1];

		expect(message).toBeDefined();
		expect(
			isReleaseCommit((message ?? "").replace("${VERSION}", "1.22.0")),
		).toBe(true);
	});

	test("the bot identity is set for both author and committer", () => {
		const commit = step(STEP.commit).run ?? "";

		expect(commit).toContain(`git config user.name ${BOT}`);
		expect(commit).toContain(`git config user.email ${BOT_EMAIL}`);
	});
});

describe("the release carries every part, with one SHA256SUMS over all of it", () => {
	test("both bootstrap scripts and the checksums join the build output before the upload", () => {
		const assets = step(STEP.assets).run ?? "";

		expect(assets).toContain("pkg/skills-cli/bootstrap.sh");
		expect(assets).toContain("pkg/skills-cli/bootstrap.ps1");
		expect(assets.indexOf("bootstrap.ps1")).toBeLessThan(
			assets.indexOf("SHA256SUMS"),
		);
		expect(step(STEP.publish).run).toContain("dist/*");
	});

	test("every build output reaches the release job through one merged download", () => {
		const download = (releaseJob.steps ?? []).find((s) =>
			s.uses?.startsWith("actions/download-artifact@"),
		);

		expect(download?.with?.path).toBe("dist");
		expect(download?.with?.["merge-multiple"]).toBe(true);
	});

	test("the checksums cover each file and are not listed in themselves", () => {
		withSandbox((sandbox) => {
			mkdirSync(join(sandbox.work, "pkg", "skills-cli"), { recursive: true });
			mkdirSync(join(sandbox.work, "dist"));
			writeFileSync(join(sandbox.work, "pkg/skills-cli/bootstrap.sh"), "sh\n");
			writeFileSync(
				join(sandbox.work, "pkg/skills-cli/bootstrap.ps1"),
				"ps1\n",
			);
			writeFileSync(join(sandbox.work, "dist/dg-skills-linux-x64"), "bin\n");
			writeFileSync(
				join(sandbox.work, "dist/dg-ai-extension-1.22.0-chrome.zip"),
				"zip\n",
			);

			const result = sandbox.run(step(STEP.assets));
			const sums = readFileSync(
				join(sandbox.work, "dist", "SHA256SUMS"),
				"utf8",
			);
			const named = sums
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split(/\s+/)[1]);

			expect(result.code, result.stderr).toBe(0);
			expect(named.sort()).toEqual([
				"bootstrap.ps1",
				"bootstrap.sh",
				"dg-ai-extension-1.22.0-chrome.zip",
				"dg-skills-linux-x64",
			]);
			const verify = Bun.spawnSync(["sha256sum", "--check", "SHA256SUMS"], {
				cwd: join(sandbox.work, "dist"),
			});
			expect(verify.exitCode).toBe(0);
		});
	});

	test("the release page shows the changelog entry of this version and nothing else", () => {
		withSandbox((sandbox) => {
			writeFileSync(
				join(sandbox.work, "CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## v1.23.0 (2026-11-02)",
					"",
					"### Fixes",
					"",
					"- newer",
					"",
					"## v1.22.0 (2026-10-28)",
					"",
					"### Features",
					"",
					"- this one",
					"",
					"## v1.21.1 (2026-10-01)",
					"",
					"- older",
					"",
				].join("\n"),
			);

			const result = sandbox.run(step(STEP.notes), { VERSION: "1.22.0" });
			const notes = readFileSync(join(sandbox.root, "tmp", "notes.md"), "utf8");

			expect(result.code, result.stderr).toBe(0);
			expect(notes).toContain("- this one");
			expect(notes).not.toContain("newer");
			expect(notes).not.toContain("older");
			expect(sandbox.run(step(STEP.notes), { VERSION: "9.9.9" }).code).not.toBe(
				0,
			);
		});
	});
});

describe("the commit, the tag and the push behave as one release", () => {
	const env = { VERSION: "1.22.0", TAG: "v1.22.0" };

	test("the bot commits the stamp and the changelog, and tags that commit", () => {
		withSandbox((sandbox) => {
			writeFileSync(join(sandbox.work, "README.md"), "stamped\n");
			writeFileSync(join(sandbox.work, "CHANGELOG.md"), "# Changelog\n");

			expect(sandbox.run(step(STEP.commit), env).code).toBe(0);

			const [author, authorEmail, committer, committerEmail, subject] = sandbox
				.git(["log", "-1", "--format=%an|%ae|%cn|%ce|%s"])
				.split("|");
			expect([author, authorEmail, committer, committerEmail]).toEqual([
				BOT,
				BOT_EMAIL,
				BOT,
				BOT_EMAIL,
			]);
			expect(isReleaseCommit(subject)).toBe(true);
			expect(
				sandbox
					.git(["show", "--name-only", "--format=", "HEAD"])
					.split("\n")
					.sort(),
			).toEqual(["CHANGELOG.md", "README.md"]);
			expect(sandbox.git(["rev-parse", "v1.22.0^{commit}"])).toBe(
				sandbox.git(["rev-parse", "HEAD"]),
			);
		});
	});

	test("one push moves master and creates the tag together", () => {
		withSandbox((sandbox) => {
			writeFileSync(join(sandbox.work, "CHANGELOG.md"), "# Changelog\n");
			sandbox.run(step(STEP.commit), env);

			const result = sandbox.run(step(STEP.push), env);
			const head = sandbox.git(["rev-parse", "HEAD"]);

			expect(result.code, result.stderr).toBe(0);
			expect(
				sandbox.git([
					"--git-dir",
					sandbox.origin,
					"rev-parse",
					"refs/heads/master",
				]),
			).toBe(head);
			expect(
				sandbox.git([
					"--git-dir",
					sandbox.origin,
					"rev-parse",
					"refs/tags/v1.22.0^{commit}",
				]),
			).toBe(head);
		});
	});

	test("when master moved, the push fails and leaves no tag and no lost commit", () => {
		withSandbox((sandbox) => {
			writeFileSync(join(sandbox.work, "CHANGELOG.md"), "# Changelog\n");
			sandbox.run(step(STEP.commit), env);

			const other = sandbox.cloneOrigin("other");
			writeFileSync(join(other, "other.txt"), "newer\n");
			sandbox.git(["add", "other.txt"], other);
			sandbox.git(["commit", "--message", "feat(other): move master"], other);
			sandbox.git(["push", "origin", "HEAD:refs/heads/master"], other);
			const moved = sandbox.git(["rev-parse", "HEAD"], other);

			expect(sandbox.run(step(STEP.push), env).code).not.toBe(0);
			expect(
				sandbox.git([
					"--git-dir",
					sandbox.origin,
					"rev-parse",
					"refs/heads/master",
				]),
			).toBe(moved);
			expect(
				sandbox.git(["--git-dir", sandbox.origin, "tag", "--list", "v1.22.0"]),
			).toBe("");
		});
	});

	test("the stale check fails when master is not the commit this run started from", () => {
		withSandbox((sandbox) => {
			const start = sandbox.git(["rev-parse", "HEAD"]);
			const run = { MODE: "release", TAG: "v1.22.0", GITHUB_SHA: start };

			expect(sandbox.run(step(STEP.stale), run).code).toBe(0);

			const other = sandbox.cloneOrigin("other");
			writeFileSync(join(other, "other.txt"), "newer\n");
			sandbox.git(["add", "other.txt"], other);
			sandbox.git(["commit", "--message", "fix(other): move master"], other);
			sandbox.git(["push", "origin", "HEAD:refs/heads/master"], other);

			const stale = sandbox.run(step(STEP.stale), run);
			expect(stale.code).not.toBe(0);
			expect(stale.stderr + stale.stdout).toContain("No tag was created");
		});
	});

	test("a republish with no tag fails, since there is nothing to republish", () => {
		withSandbox((sandbox) => {
			const start = sandbox.git(["rev-parse", "HEAD"]);
			const result = sandbox.run(step(STEP.stale), {
				MODE: "republish",
				TAG: "v1.22.0",
				GITHUB_SHA: start,
			});

			expect(result.code).not.toBe(0);
		});
	});

	test("the tagged commit must be the release commit for this version", () => {
		withSandbox((sandbox) => {
			const start = sandbox.git(["rev-parse", "HEAD"]);
			const run = { ...env, MODE: "release", GITHUB_SHA: start };
			sandbox.git(["tag", "v1.22.0"]);
			const wrong = sandbox.run(step(STEP.tagged), run);

			writeFileSync(join(sandbox.work, "CHANGELOG.md"), "# Changelog\n");
			sandbox.run(step(STEP.commit), { VERSION: "1.22.0", TAG: "v1.22.1" });
			sandbox.git(["tag", "--force", "v1.22.0", "HEAD"]);
			const right = sandbox.run(step(STEP.tagged), run);

			expect(wrong.code).not.toBe(0);
			expect(right.code, right.stderr).toBe(0);
		});
	});

	test("the latest tag moves to the release commit and nothing else is forced", () => {
		withSandbox((sandbox) => {
			const first = sandbox.git(["rev-parse", "HEAD"]);
			sandbox.git(["tag", "v1.0.1"]);
			expect(sandbox.run(step(STEP.latest), { TAG: "v1.0.1" }).code).toBe(0);
			const latest = () =>
				sandbox.git([
					"--git-dir",
					sandbox.origin,
					"rev-parse",
					"refs/tags/latest^{commit}",
				]);
			expect(latest()).toBe(first);

			writeFileSync(join(sandbox.work, "next.txt"), "next\n");
			sandbox.git(["add", "next.txt"]);
			sandbox.git(["commit", "--message", "chore(release): cut 1.0.2"]);
			sandbox.git(["tag", "v1.0.2"]);
			const second = sandbox.git(["rev-parse", "HEAD"]);
			const master = sandbox.git([
				"--git-dir",
				sandbox.origin,
				"rev-parse",
				"refs/heads/master",
			]);

			expect(sandbox.run(step(STEP.latest), { TAG: "v1.0.2" }).code).toBe(0);
			expect(latest()).toBe(second);
			expect(
				sandbox.git([
					"--git-dir",
					sandbox.origin,
					"rev-parse",
					"refs/heads/master",
				]),
			).toBe(master);
		});
	});
});

describe("an older release never moves latest backward", () => {
	function originRef(sandbox: StepSandbox, ref: string): string {
		return sandbox.git(["--git-dir", sandbox.origin, "rev-parse", ref]);
	}

	function tagTwoReleases(
		sandbox: StepSandbox,
		older: string,
		newer: string,
	): { first: string; second: string } {
		const first = sandbox.git(["rev-parse", "HEAD"]);
		sandbox.git(["tag", older]);
		writeFileSync(join(sandbox.work, "next.txt"), "next\n");
		sandbox.git(["add", "next.txt"]);
		sandbox.git(["commit", "--message", "chore(release): cut next"]);
		sandbox.git(["tag", newer]);
		sandbox.git(["tag", "skills-v9.9.9"]);
		return { first, second: sandbox.git(["rev-parse", "HEAD"]) };
	}

	test("rerunning an older release leaves the latest tag on the newest release", () => {
		withSandbox((sandbox) => {
			const { second } = tagTwoReleases(sandbox, "v1.0.1", "v1.0.2");
			expect(sandbox.run(step(STEP.latest), { TAG: "v1.0.2" }).code).toBe(0);

			const result = sandbox.run(step(STEP.latest), { TAG: "v1.0.1" });

			expect(result.code, result.stderr).toBe(0);
			expect(originRef(sandbox, "refs/tags/latest^{commit}")).toBe(second);
		});
	});

	test("rerunning the newest release still moves the latest tag", () => {
		withSandbox((sandbox) => {
			const { first, second } = tagTwoReleases(sandbox, "v1.0.1", "v1.0.2");
			sandbox.git(["push", "origin", `${first}:refs/tags/latest`]);
			expect(originRef(sandbox, "refs/tags/latest^{commit}")).toBe(first);

			const result = sandbox.run(step(STEP.latest), { TAG: "v1.0.2" });

			expect(result.code, result.stderr).toBe(0);
			expect(originRef(sandbox, "refs/tags/latest^{commit}")).toBe(second);
		});
	});

	test("versions compare as numbers, so v1.10.0 is newer than v1.9.0", () => {
		withSandbox((sandbox) => {
			const { second } = tagTwoReleases(sandbox, "v1.9.0", "v1.10.0");

			expect(sandbox.run(step(STEP.latest), { TAG: "v1.9.0" }).code).toBe(0);
			expect(
				sandbox.git(["--git-dir", sandbox.origin, "tag", "--list", "latest"]),
			).toBe("");

			expect(sandbox.run(step(STEP.latest), { TAG: "v1.10.0" }).code).toBe(0);
			expect(originRef(sandbox, "refs/tags/latest^{commit}")).toBe(second);
		});
	});
});

describe("a rerun accepts a tag only when its own commit produced it", () => {
	const env = { VERSION: "1.22.0", TAG: "v1.22.0" };

	function cutRelease(sandbox: StepSandbox): {
		older: string;
		start: string;
		release: string;
	} {
		const older = sandbox.git(["rev-parse", "HEAD"]);
		writeFileSync(join(sandbox.work, "fix.txt"), "fix\n");
		sandbox.git(["add", "fix.txt"]);
		sandbox.git(["commit", "--message", "fix(other): newer fix"]);
		const start = sandbox.git(["rev-parse", "HEAD"]);
		writeFileSync(join(sandbox.work, "CHANGELOG.md"), "# Changelog\n");
		sandbox.run(step(STEP.commit), env);
		return { older, start, release: sandbox.git(["rev-parse", "HEAD"]) };
	}

	test("a release run takes the tag whose parent is the commit it started from", () => {
		withSandbox((sandbox) => {
			const { start } = cutRelease(sandbox);

			const result = sandbox.run(step(STEP.tagged), {
				...env,
				MODE: "release",
				GITHUB_SHA: start,
			});

			expect(result.code, result.stderr + result.stdout).toBe(0);
		});
	});

	test("an older failed run that computes the same version refuses the tag a later run created", () => {
		withSandbox((sandbox) => {
			const { older } = cutRelease(sandbox);

			const result = sandbox.run(step(STEP.tagged), {
				...env,
				MODE: "release",
				GITHUB_SHA: older,
			});

			expect(result.code).not.toBe(0);
			expect(result.stderr + result.stdout).toContain("different commit");
		});
	});

	test("a republish run takes the tag on its own commit and refuses a tag on any other", () => {
		withSandbox((sandbox) => {
			const { start, release } = cutRelease(sandbox);

			const own = sandbox.run(step(STEP.tagged), {
				...env,
				MODE: "republish",
				GITHUB_SHA: release,
			});
			const other = sandbox.run(step(STEP.tagged), {
				...env,
				MODE: "republish",
				GITHUB_SHA: start,
			});

			expect(own.code, own.stderr + own.stdout).toBe(0);
			expect(other.code).not.toBe(0);
			expect(other.stderr + other.stdout).toContain("different commit");
		});
	});
});

describe("publishing is a draft first, then one call that publishes and marks latest", () => {
	function prepare(sandbox: StepSandbox): { target: string; files: string[] } {
		sandbox.git(["tag", "v1.22.0"]);
		mkdirSync(join(sandbox.work, "dist"));
		const files = ["dg-skills-linux-x64", "bootstrap.sh", "SHA256SUMS"];
		for (const name of files)
			writeFileSync(join(sandbox.work, "dist", name), `${name}\n`);
		writeFileSync(join(sandbox.root, "tmp", "notes.md"), "notes\n");
		return { target: sandbox.git(["rev-parse", "HEAD"]), files };
	}

	const env = { TAG: "v1.22.0" };

	test("a fresh release uploads every file to a draft, then publishes it as latest", () => {
		withSandbox((sandbox) => {
			const { target, files } = prepare(sandbox);

			const result = sandbox.run(step(STEP.publish), env);
			const calls = ghCalls(sandbox);
			const create = calls.findIndex((call) =>
				call.startsWith("release create v1.22.0"),
			);
			const edit = calls.findIndex(
				(call) => call === "release edit v1.22.0 --draft=false --latest",
			);

			expect(result.code, result.stderr).toBe(0);
			expect(create).toBeGreaterThan(-1);
			expect(edit).toBeGreaterThan(create);
			expect(calls[create]).toContain("--draft");
			expect(calls[create]).toContain(`--target ${target}`);
			for (const name of files) expect(calls[create]).toContain(`dist/${name}`);
			expect(calls.some((call) => call.includes("DELETE"))).toBe(false);
		});
	});

	test("an older release is published without the latest mark when a newer release exists", () => {
		withSandbox((sandbox) => {
			prepare(sandbox);
			sandbox.git(["tag", "v1.23.0"]);
			sandbox.git(["tag", "skills-v9.9.9"]);

			const result = sandbox.run(step(STEP.publish), env);
			const edits = ghCalls(sandbox).filter((call) =>
				call.startsWith("release edit"),
			);

			expect(result.code, result.stderr).toBe(0);
			expect(edits).toEqual(["release edit v1.22.0 --draft=false --latest=false"]);
		});
	});

	test("a leftover draft is deleted first, and only the draft", () => {
		withSandbox((sandbox) => {
			prepare(sandbox);

			const result = sandbox.run(step(STEP.publish), {
				...env,
				STUB_DRAFTS: "11 12",
			});
			const calls = ghCalls(sandbox);
			const lastDelete = calls
				.map((c) => c.includes("DELETE"))
				.lastIndexOf(true);
			const create = calls.findIndex((call) =>
				call.startsWith("release create"),
			);

			expect(result.code, result.stderr).toBe(0);
			expect(calls.filter((call) => call.includes("DELETE"))).toEqual([
				"api --method DELETE repos/owner/repo/releases/11",
				"api --method DELETE repos/owner/repo/releases/12",
			]);
			expect(create).toBeGreaterThan(lastDelete);
		});
	});

	test("an already published release is left alone", () => {
		withSandbox((sandbox) => {
			prepare(sandbox);

			const result = sandbox.run(step(STEP.publish), {
				...env,
				STUB_PUBLISHED: "v1.22.0",
			});
			const calls = ghCalls(sandbox);

			expect(result.code, result.stderr).toBe(0);
			expect(calls.some((call) => call.startsWith("release create"))).toBe(
				false,
			);
			expect(calls.some((call) => call.startsWith("release edit"))).toBe(false);
		});
	});
});

describe("the step text names its release parts the same way the install code reads them", () => {
	test("the release page title and the tag are both vX.Y.Z", () => {
		expect(step(STEP.publish).run).toContain('--title "$TAG"');
		expect(releaseJob.env?.TAG).toBe("v${{ needs.detect.outputs.version }}");
		expect(stepText(step(STEP.publish))).not.toContain("skills-v");
	});
});

const VERSION_EXPR = "${{ needs.detect.outputs.version }}";
const DOCUMENTED_ASSETS = [
	"dg-ai-extension-<v>-chrome.zip",
	"dg-ai-extension-<v>-firefox.zip",
	"SHA256SUMS",
	"bootstrap.ps1",
	"bootstrap.sh",
	"dg-demo-narration-<v>.zip",
	"dg-lib-<v>.tar.gz",
	"runtime.json",
];

function uploadedNames(jobId: string): string[] {
	const upload = (workflow.jobs[jobId]?.steps ?? []).find((s) =>
		s.uses?.startsWith("actions/upload-artifact@"),
	);
	return String(upload?.with?.path ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((path) => (path.split("/").pop() ?? "").replaceAll(VERSION_EXPR, "<v>"));
}

function smokeJobIds(): string[] {
	return Object.keys(workflow.jobs).filter((id) => id.startsWith("smoke"));
}

describe("the release builds one bundle and smokes it on all six platforms", () => {
	test("exactly one job builds the bundle and no per-binary build job remains", () => {
		const builders = Object.keys(workflow.jobs).filter((id) => id.startsWith("build-"));

		expect(builders.sort()).toEqual(["build-bundle", "build-ext", "build-narration"]);
		expect(workflow.jobs["build-bundle"].strategy).toBeUndefined();
		expect(text).not.toContain("--compile");
	});

	test("build-bundle uploads the tarball and runtime.json under the stamped version", () => {
		expect(uploadedNames("build-bundle").sort()).toEqual([`dg-lib-<v>.tar.gz`, "runtime.json"]);
		expect(text).toContain(`dg-lib-${VERSION_EXPR}.tar.gz`);
	});

	test("one smoke job runs a six-runner matrix, one native runner per supported platform", () => {
		const ids = smokeJobIds();
		expect(ids.length).toBe(1);
		const matrix = workflow.jobs[ids[0] as string]?.strategy?.matrix?.include ?? [];

		expect(matrix.length).toBe(SUPPORTED_PLATFORMS.length);
		for (const { runners } of SUPPORTED_PLATFORMS) {
			expect(matrix.filter((entry) => runners.includes(entry.os)).length).toBe(1);
		}
	});

	test("the smoke job waits for the bundle and the release waits for the smoke job", () => {
		const id = smokeJobIds()[0] as string;

		expect(jobNeeds(workflow.jobs[id] as WorkflowJob)).toContain("build-bundle");
		expect(jobNeeds(releaseJob)).toEqual(expect.arrayContaining(["build-bundle", "build-ext", "build-narration", id]));
	});
});

describe("the release publishes exactly the documented asset names", () => {
	test("the build jobs, the bootstrap scripts and SHA256SUMS add up to the documented list and nothing else", () => {
		const fromBuilds = ["build-bundle", "build-ext", "build-narration"].flatMap(uploadedNames);
		const extras = ["bootstrap.sh", "bootstrap.ps1", "SHA256SUMS"].filter((name) =>
			(step(STEP.assets).run ?? "").includes(name),
		);
		const published = [...fromBuilds, ...extras]
			.sort();

		expect(published).toEqual([...DOCUMENTED_ASSETS].sort());
	});

	test("no other job uploads an artifact that reaches the release", () => {
		const uploaders = Object.entries(workflow.jobs)
			.filter(([, job]) => (job.steps ?? []).some((s) => s.uses?.startsWith("actions/upload-artifact@")))
			.map(([id]) => id);

		expect(uploaders.sort()).toEqual(["build-bundle", "build-ext", "build-narration"]);
	});
});
