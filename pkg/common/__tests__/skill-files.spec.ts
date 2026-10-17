import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { filesToInstall, skillDirectoryNames } from "../src/skill-files";

function walk(root: string): string[] {
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			if (statSync(abs).isDirectory()) visit(abs);
			else files.push(relative(root, abs).split(sep).join("/"));
		}
	};
	visit(root);
	return files;
}

describe("skillDirectoryNames", () => {
	test("names only an immediate directory whose file is SKILL.md", () => {
		expect(
			skillDirectoryNames([
				"google-sms-cleanup/SKILL.md",
				"browser/SKILL.md",
				"browser/references/install.md",
				"nested/deeper/SKILL.md",
				"README.md",
				"/abs/SKILL.md",
			]),
		).toEqual(["browser", "google-sms-cleanup"]);
	});
});

/** Hand-listed skill files. This is not derived from the installer rule. */
const INSTALLED_SKILL_FILES = [
	"address/SKILL.md",
	"address/references/agents.md",
	"address/references/github-api.md",
	"address/references/workflow.md",
	"agent-seed/SKILL.md",
	"agent-seed/references/classification.md",
	"agent-seed/references/templates.md",
	"agent-seed/references/workflow.md",
	"browser/SKILL.md",
	"browser/references/install.md",
	"catchup/SKILL.md",
	"chain/SKILL.md",
	"channel-review/SKILL.md",
	"channel-review/references/commands.md",
	"channel-review/references/config.example.json",
	"channel-review/references/relay-setup.md",
	"channel-review/references/setup.md",
	"chat/SKILL.md",
	"clipboard-img/SKILL.md",
	"demo/SKILL.md",
	"demo/references/authoring.md",
	"deps-upgrade/SKILL.md",
	"deps-upgrade/references/ecosystems.md",
	"deps-upgrade/references/steps.md",
	"file/SKILL.md",
	"google-sms-cleanup/SKILL.md",
	"grill-me/SKILL.md",
	"grill-me/references/decision-log.md",
	"grill-me/references/decisions.md",
	"grill-me/references/protocol.md",
	"hook-comment-disable/SKILL.md",
	"hunt/SKILL.md",
	"hunt/references/hunt.workflow.mjs",
	"hunt/references/protocol.md",
	"inbox-cleanup/SKILL.md",
	"inbox-cleanup/references/providers.md",
	"inbox-cleanup/references/workflow.md",
	"kick/SKILL.md",
	"kick/references/args.md",
	"meaningful/SKILL.md",
	"meaningful/references/example-plan.json",
	"meaningful/references/helper-api.md",
	"meaningful/references/proposal-format.md",
	"overwatch/SKILL.md",
	"pickup/SKILL.md",
	"pickup/references/args.md",
	"pickup/references/loading.md",
	"prd/SKILL.md",
	"proto/SKILL.md",
	"proto/agents/openai.yaml",
	"proto/references/commands.md",
	"proto/references/contracts.md",
	"proxy/SKILL.md",
	"pushup/SKILL.md",
	"refactor/SKILL.md",
	"refactor/references/deepening.md",
	"refactor/references/design-handoff.md",
	"refactor/references/discovery.md",
	"refactor/references/interface-design.md",
	"refactor/references/language-rationale.md",
	"refactor/references/language.md",
	"rename-session/SKILL.md",
	"review-loop/SKILL.md",
	"review-loop/references/antagonist-prompt.md",
	"review-loop/references/proxy-review-prompt.md",
	"review-loop/references/proxy-workflow.md",
	"review-loop/references/workflow.md",
	"standard-test/SKILL.md",
	"standard-test/references/examples-csharp.md",
	"standard-test/references/examples-generic.md",
	"standard-test/references/examples-js.md",
	"standard-test/references/examples-python.md",
	"standard-test/references/examples-shell.md",
	"standard-test/references/principles-rationale.md",
	"standard-test/references/principles.md",
	"stash/SKILL.md",
	"teach/SKILL.md",
	"teach/references/GLOSSARY-FORMAT.md",
	"teach/references/LEARNING-RECORD-FORMAT.md",
	"teach/references/MISSION-FORMAT.md",
	"teach/references/RESOURCES-FORMAT.md",
	"teach/references/content-types.md",
	"thrash/SKILL.md",
	"thrash/references/agent-prompt.md",
	"thrash/references/details.md",
	"wait-what/SKILL.md",
	"walk/SKILL.md",
	"wayfinder/SKILL.md",
	"wayfinder/references/map.md",
	"wayfinder/references/work.md",
	"what-changed/SKILL.md",
	"what-changed/scripts/range.ts",
];

describe("filesToInstall", () => {
	test("keeps every file under a skill directory, including references", () => {
		expect(
			filesToInstall([
				"README.md",
				"loose/notes.md",
				"browser/SKILL.md",
				"browser/references/install.md",
				"google-sms-cleanup/SKILL.md",
				"nested/deeper/SKILL.md",
				"nested/deeper/note.md",
			]),
		).toEqual([
			"browser/SKILL.md",
			"browser/references/install.md",
			"google-sms-cleanup/SKILL.md",
		]);
	});

	test("returns paths in sorted order", () => {
		expect(
			filesToInstall(["zebra/SKILL.md", "alpha/note.md", "alpha/SKILL.md"]),
		).toEqual(["alpha/SKILL.md", "alpha/note.md", "zebra/SKILL.md"]);
	});

	test("drops duplicates, dot segments, and parent traversal", () => {
		expect(
			filesToInstall([
				"ok/SKILL.md",
				"ok/SKILL.md",
				"ok",
				"ok/../../etc/passwd",
				"ok/./note.md",
				"ok//blank.md",
				"ok/foo\\bar.md",
				"/ok/secret",
				"ok\\secret.md",
			]),
		).toEqual(["ok/SKILL.md"]);
	});

	test("installs the repository skill tree from an explicit list", () => {
		let dir = import.meta.dir;
		let root = "";
		for (let i = 0; i < 10; i++) {
			const candidate = join(dir, "plugins", "dg", "skills");
			if (existsSync(join(candidate, "google-sms-cleanup", "SKILL.md"))) {
				root = candidate;
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		expect(root).not.toBe("");
		const tree = walk(root);
		expect(filesToInstall(tree)).toEqual(INSTALLED_SKILL_FILES);
		expect(tree).toContain("README.md");
		expect(filesToInstall(tree)).not.toContain("README.md");
	});
});
