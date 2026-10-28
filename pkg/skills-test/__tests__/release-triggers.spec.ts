import { describe, expect, test } from "bun:test";
import {
	jobNeeds,
	parseWorkflow,
	reaches,
	workflowFiles,
	workflowText,
} from "./workflow-support";

const BLT_GATES = [
	{ job: "blt-skills", file: "skills-blt.yml" },
	{ job: "blt-ext", file: "ext-blt.yml" },
	{ job: "blt-daemon", file: "dg-daemon-blt.yml" },
	{ job: "blt-agent", file: "dg-agent-blt.yml" },
] as const;

const SKIP_GUARD = "needs.detect.outputs.mode != 'skip'";

const release = parseWorkflow("release.yml");

describe("one workflow cuts every release", () => {
	test("release.yml is the only release workflow", () => {
		const files = workflowFiles();

		expect(files).toContain("release.yml");
		expect(files.filter((name) => name.endsWith("-release.yml"))).toEqual([]);
		expect(files).not.toContain("release-all.yml");
	});

	test("a push to master triggers it, with no path filter", () => {
		expect(release.on.push?.branches).toEqual(["master"]);
		expect(release.on.push?.paths).toBeUndefined();
		expect(workflowText("release.yml")).not.toContain("paths-ignore");
	});

	test("a manual dispatch takes a bump input of auto, patch, minor or major", () => {
		const bump = release.on.workflow_dispatch?.inputs?.bump;

		expect(bump?.type).toBe("choice");
		expect(bump?.options).toEqual(["auto", "patch", "minor", "major"]);
	});

	test("nothing but a push to master or a dispatch can start it", () => {
		expect(Object.keys(release.on).sort()).toEqual([
			"push",
			"workflow_dispatch",
		]);
	});

	test("one release runs at a time and an in-progress release is never canceled", () => {
		expect(release.concurrency?.group).toBe("release");
		expect(release.concurrency?.["cancel-in-progress"]).toBe(false);
	});
});

describe("a release publishes only after every build workflow passes", () => {
	for (const { job, file } of BLT_GATES) {
		test(`${job} calls ${file} and the release job waits on it`, () => {
			expect(release.jobs[job]?.uses).toBe(`./.github/workflows/${file}`);
			expect(reaches(release, "release", job)).toBe(true);
		});
	}

	test("every gate and every build starts only after detect", () => {
		for (const { job } of BLT_GATES) {
			expect(jobNeeds(release.jobs[job])).toContain("detect");
		}
		for (const job of [
			"build-skills",
			"build-daemon",
			"build-agent",
			"build-ext",
		]) {
			expect(jobNeeds(release.jobs[job])).toContain("detect");
		}
	});

	test("each part is built only after its own gate, and each binary smoked only after its build", () => {
		expect(jobNeeds(release.jobs["build-skills"])).toContain("blt-skills");
		expect(jobNeeds(release.jobs["build-daemon"])).toContain("blt-daemon");
		expect(jobNeeds(release.jobs["build-agent"])).toContain("blt-agent");
		expect(jobNeeds(release.jobs["build-ext"])).toContain("blt-ext");
		expect(jobNeeds(release.jobs["smoke-skills"])).toEqual(["build-skills"]);
		expect(jobNeeds(release.jobs["smoke-daemon"])).toEqual(["build-daemon"]);
		expect(jobNeeds(release.jobs["smoke-agent"])).toEqual(["build-agent"]);
	});

	test("the release job waits on every smoke run and the extension build", () => {
		const needs = jobNeeds(release.jobs.release);

		for (const job of [
			"detect",
			"smoke-skills",
			"smoke-daemon",
			"smoke-agent",
			"build-ext",
		]) {
			expect(needs).toContain(job);
		}
	});
});

describe("a skipped detection skips everything after it", () => {
	test("every job that reads the detection says so in its own condition", () => {
		const reading = Object.entries(release.jobs).filter(([, job]) =>
			jobNeeds(job).includes("detect"),
		);

		expect(reading.length).toBeGreaterThan(1);
		for (const [id, job] of reading) {
			expect([id, job.if]).toEqual([id, SKIP_GUARD]);
		}
	});

	test("the smoke jobs name no condition, and a skipped build skips them", () => {
		for (const job of ["smoke-skills", "smoke-daemon", "smoke-agent"]) {
			expect(release.jobs[job].if).toBeUndefined();
			expect(reaches(release, job, "detect")).toBe(true);
		}
	});

	test("detect refuses to run from any ref but master", () => {
		expect(workflowText("release.yml")).toContain(
			"github.ref != 'refs/heads/master'",
		);
	});
});
