import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCompiledBinary } from "./compiled-binary";
import { makeTempDir } from "./git-repo-fixtures";

setDefaultTimeout(60_000);

const REPO_SKILL_PUBLISH = join(import.meta.dir, "..", "..", "..", "plugins", "dg", "skills", "skill-publish");

let bin: string;
let cwd: string;
let schemaRoot: string;
let home: string;
const roots: string[] = [];

function tempDir(prefix: string): string {
	const dir = makeTempDir(prefix);
	roots.push(dir);
	return dir;
}

beforeAll(() => {
	bin = buildCompiledBinary();
	cwd = tempDir("skill-publish-compiled-cwd-");
	home = tempDir("skill-publish-compiled-home-");
	schemaRoot = tempDir("skill-publish-compiled-skills-");
	mkdirSync(join(schemaRoot, "skill-publish", "references"), { recursive: true });
	for (const file of ["manifest.schema.json", "plugin.schema.json"]) {
		writeFileSync(
			join(schemaRoot, "skill-publish", "references", file),
			readFileSync(join(REPO_SKILL_PUBLISH, "references", file), "utf-8"),
		);
	}
}, 240_000);

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function run(args: string[], opts: { input?: string; env?: Record<string, string | undefined> } = {}) {
	const proc = Bun.spawn([bin, "skill-publish", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: opts.input === undefined ? "ignore" : Buffer.from(opts.input),
		cwd,
		env: { PATH: process.env.PATH, HOME: home, DG_SKILLS_DIR: schemaRoot, ...opts.env },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

function writeFakeSkill(dir: string, name: string): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: A fake skill.\n---\n\n# ${name}\n`);
	return skillDir;
}

function snapshot(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

describe("compiled dg-skills skill-publish from an external cwd", () => {
	test("analyze reports a Bun-TS file as publishable", async () => {
		const tool = join(cwd, "tool.ts");
		writeFileSync(tool, "#!/usr/bin/env bun\nconsole.log(1);\n");
		const { code, out } = await run(["analyze", tool]);
		expect(code).toBe(0);
		expect(JSON.parse(out)).toEqual({ publishable: true, issues: [], routing: "bun-ts" });
	});

	test("manifest validate loads the schema from the owning installed skill, not a local literal", async () => {
		const manifestPath = join(cwd, "ok.publish.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				name: "myserver",
				version: "1.0.0",
				description: "d",
				recipe: "r",
				tools: [{ name: "echo", description: "e", inputSchema: { type: "object" } }],
			}),
		);
		const { code, err } = await run(["manifest", "validate", manifestPath]);
		expect(code).toBe(0);
		expect(err).toBe("");
	});

	test("generate writes a standalone server.ts outside the checkout", async () => {
		const manifestPath = join(cwd, "gen.publish.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				name: "myserver",
				version: "1.0.0",
				description: "d",
				recipe: "r",
				tools: [{ name: "echo", description: "e", inputSchema: { type: "object" } }],
			}),
		);
		const outDir = join(cwd, "gen-out");
		const { code, out } = await run(["generate", manifestPath, "--out-dir", outDir]);
		expect(code).toBe(0);
		expect(out.trim()).toBe(outDir);
		expect(existsSync(join(outDir, "server.ts"))).toBe(true);
	});

	test("plugin generate: an existing dg plugin checkout survives, only the named skill is written", async () => {
		const repoRoot = tempDir("skill-publish-compiled-repo-");
		mkdirSync(join(repoRoot, "plugins", "dg", ".claude-plugin"), { recursive: true });
		writeFileSync(join(repoRoot, "plugins", "dg", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dg" }));
		const existingSkill = join(repoRoot, "plugins", "dg", "skills", "existing");
		mkdirSync(existingSkill, { recursive: true });
		writeFileSync(join(existingSkill, "SKILL.md"), "---\nname: existing\n---\n# existing\n");
		const before = snapshot(repoRoot);

		const sourceSkill = writeFakeSkill(cwd, "greet-skill");
		const manifestPath = join(cwd, "plugin.json");
		writeFileSync(manifestPath, JSON.stringify({ name: "test-plugin", description: "d", skills: [sourceSkill] }));

		const { code } = await run(
			["plugin", "generate", manifestPath, "--root", join(repoRoot, "plugins", "dg")],
			{ input: "y\n" },
		);
		expect(code).toBe(0);

		expect(existsSync(join(repoRoot, "plugins", "dg", "skills", "greet-skill", "SKILL.md"))).toBe(true);
		const after = snapshot(repoRoot).filter((f) => !f.includes(join("skills", "greet-skill")));
		expect(after).toEqual(before);
	});

	test("plugin generate: a planted secret hard-blocks, with no writes anywhere", async () => {
		const repoRoot = tempDir("skill-publish-compiled-repo-secret-");
		mkdirSync(join(repoRoot, "plugins", "dg", ".claude-plugin"), { recursive: true });
		writeFileSync(join(repoRoot, "plugins", "dg", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dg" }));

		const skillDir = join(cwd, "secret-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: secret-skill\n---\n# x\n\nAKIAABCDEFGHIJKLMNOP\n");
		const manifestPath = join(cwd, "secret-plugin.json");
		writeFileSync(manifestPath, JSON.stringify({ name: "test-plugin", description: "d", skills: [skillDir] }));

		const { code, err } = await run(["plugin", "generate", manifestPath, "--root", join(repoRoot, "plugins", "dg")]);
		expect(code).toBe(1);
		expect(err.toLowerCase()).toContain("secret");
		expect(existsSync(join(repoRoot, "plugins", "dg", "skills", "secret-skill"))).toBe(false);
	});

	test("refuses to write into an installed plugin cache path even when the binary runs outside any checkout", async () => {
		const cacheRoot = join(home, ".claude", "plugins", "cache", "market", "dg", "1.0.0", "plugins", "dg");
		mkdirSync(join(cacheRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(join(cacheRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dg" }));

		const skillDir = writeFakeSkill(cwd, "cache-skill");
		const manifestPath = join(cwd, "cache-plugin.json");
		writeFileSync(manifestPath, JSON.stringify({ name: "test-plugin", description: "d", skills: [skillDir] }));

		const { code, err } = await run(["plugin", "generate", manifestPath, "--root", cacheRoot], { input: "y\n" });
		expect(code).toBe(1);
		expect(err).toContain("installed plugin cache");
		expect(existsSync(join(cacheRoot, "skills", "cache-skill"))).toBe(false);
	});

	test("no unrelated writes land under the fake HOME's .dg/bin while running these commands", async () => {
		expect(existsSync(join(home, ".dg"))).toBe(false);
	});
});
