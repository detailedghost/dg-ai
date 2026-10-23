import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkflow } from "../src/test-live/discover";

let workflowsDir: string;
let savedCwd: string;

beforeEach(() => {
	workflowsDir = mkdtempSync(join(tmpdir(), "test-live-discover-"));
	savedCwd = process.cwd();
	process.chdir(workflowsDir);
});

afterEach(() => {
	process.chdir(savedCwd);
	rmSync(workflowsDir, { recursive: true, force: true });
});

function writeWorkflow(name: string): void {
	mkdirSync(workflowsDir, { recursive: true });
	writeFileSync(join(workflowsDir, name), "on:\n  push:\n    branches: [main]\n");
}

describe("findWorkflow — .yaml extension support", () => {
	test("matches an exact-candidate workflow with a .yaml extension", () => {
		writeWorkflow("deploy-dev.yaml");
		expect(findWorkflow("dev", workflowsDir)).toBe(join(workflowsDir, "deploy-dev.yaml"));
	});

	test("still matches an exact-candidate workflow with a .yml extension", () => {
		writeWorkflow("deploy_dev.yml");
		expect(findWorkflow("dev", workflowsDir)).toBe(join(workflowsDir, "deploy_dev.yml"));
	});

	test("falls back to a wildcard match on a .yaml workflow", () => {
		writeWorkflow("custom-dev-pipeline.yaml");
		expect(findWorkflow("dev", workflowsDir)).toBe(join(workflowsDir, "custom-dev-pipeline.yaml"));
	});

	test("falls back to deploy.yaml for dev when nothing else matches", () => {
		writeWorkflow("deploy.yaml");
		expect(findWorkflow("dev", workflowsDir)).toBe(join(workflowsDir, "deploy.yaml"));
	});

	test("throws when no workflow file matches any extension", () => {
		writeWorkflow("unrelated.yaml");
		expect(() => findWorkflow("prod", workflowsDir)).toThrow("no prod workflow file found");
	});
});
