import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./git-repo-fixtures";

export type FixtureSpec = {
	files: Record<string, string>;
	links?: Record<string, string>;
	gitlinks?: Record<string, string>;
	manifestSkills?: string[];
};

const created: string[] = [];

export function removeRecommendedFixtures(): void {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `dg-${prefix}-`));
	created.push(dir);
	return dir;
}

export function skillMarkdown(name: string): string {
	return `---\nname: ${name}\ndescription: ${name} fixture skill\n---\n\n# ${name}\n`;
}

export function mattpocockLikeFiles(names: string[]): FixtureSpec {
	const files: Record<string, string> = {};
	for (const name of names) {
		files[`skills/${name}/SKILL.md`] = skillMarkdown(name);
		files[`skills/${name}/references/notes.md`] = `notes for ${name}\n`;
	}
	return { files, manifestSkills: names.map((name) => `./skills/${name}`) };
}

export function bareRepo(root: string, spec: FixtureSpec): { url: string; sha: string; bare: string } {
	const work = join(root, "work");
	const bare = join(root, "origin.git");
	mkdirSync(work, { recursive: true });
	git(["init", "-q", "-b", "main"], work);
	for (const [path, content] of Object.entries(spec.files)) {
		mkdirSync(dirname(join(work, path)), { recursive: true });
		writeFileSync(join(work, path), content);
	}
	if (spec.manifestSkills) {
		mkdirSync(join(work, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(work, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "fixture", skills: spec.manifestSkills }),
		);
	}
	for (const [path, target] of Object.entries(spec.links ?? {})) {
		mkdirSync(dirname(join(work, path)), { recursive: true });
		symlinkSync(target, join(work, path));
	}
	git(["add", "-A"], work);
	for (const [path, sha] of Object.entries(spec.gitlinks ?? {})) {
		git(["update-index", "--add", "--cacheinfo", `160000,${sha},${path}`], work);
	}
	git(["commit", "-q", "-m", "fixture"], work);
	const sha = git(["rev-parse", "HEAD"], work).trim();
	git(["clone", "-q", "--bare", work, bare], root);
	git(["config", "uploadpack.allowAnySHA1InWant", "true"], bare);
	return { url: `file://${bare}`, sha, bare };
}

export type HarnessOutcome = { written: string[]; lines: string[]; thrown?: string };

export function runRecommendedSkillsOnly(
	plugin: { name: string; repo: string; sha: string; skills?: string[] },
	dest: string,
	dgNames: string[],
	redirect: { repo: string; url: string },
	extraEnv: Record<string, string> = {},
): HarnessOutcome {
	const dir = tempDir("recommended-harness");
	const module = join(import.meta.dir, "..", "src", "install", "recommended-skills-only.ts");
	const script = join(dir, "harness.ts");
	writeFileSync(
		script,
		`import { installRecommendedSkillsOnly } from ${JSON.stringify(module)};
const input = JSON.parse(process.env.HARNESS_INPUT ?? "{}");
const lines: string[] = [];
let written: string[] = [];
let thrown: string | undefined;
try {
	written = installRecommendedSkillsOnly(input.plugin, input.dest, new Set(input.dgNames), (line: string) => lines.push(line));
} catch (error) {
	thrown = String(error);
}
console.log(JSON.stringify({ written, lines, thrown }));
`,
	);
	const proc = Bun.spawnSync(["bun", "run", script], {
		cwd: dir,
		env: {
			...process.env,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `url.${redirect.url}.insteadOf`,
			GIT_CONFIG_VALUE_0: `https://github.com/${redirect.repo}.git`,
			GIT_TERMINAL_PROMPT: "0",
			HARNESS_INPUT: JSON.stringify({ plugin, dest, dgNames }),
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = proc.stdout.toString().trim().split("\n").pop() ?? "";
	if (!out.startsWith("{")) throw new Error(`harness failed: ${proc.stderr.toString()}`);
	return JSON.parse(out) as HarnessOutcome;
}

export function writeInstalledPlugins(home: string, shas: Record<string, string>): void {
	const plugins = Object.fromEntries(
		Object.entries(shas).map(([ref, gitCommitSha]) => [
			ref,
			[{ scope: "user", installPath: join(home, ".claude", "plugins", "cache", ref), version: "1.0.0", gitCommitSha }],
		]),
	);
	const file = join(home, ".claude", "plugins", "installed_plugins.json");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ version: 2, plugins }));
}

export function writeMarketplaceClone(configDir: string, pins: Record<string, string>): void {
	const clone = join(configDir, "plugins", "marketplaces", "detailedghost");
	mkdirSync(join(clone, ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(clone, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			plugins: Object.entries(pins).map(([name, sha]) => ({ name, source: { source: "github", repo: `owner/${name}`, sha } })),
		}),
	);
	writeFileSync(
		join(configDir, "plugins", "known_marketplaces.json"),
		JSON.stringify({
			detailedghost: { source: { source: "github", repo: "detailedghost/dg-ai" }, installLocation: clone, lastUpdated: "2026-01-01T00:00:00Z" },
		}),
	);
}
