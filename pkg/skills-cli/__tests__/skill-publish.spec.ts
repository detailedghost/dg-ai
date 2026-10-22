import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSource } from "../src/skill-publish/analyze";
import { assertNotInstalledCache, assertNotSelfMove, findSourceCheckoutPluginRoot } from "../src/skill-publish/checkout";
import { cmdGenerate, toPortable } from "../src/skill-publish/generate";
import { introspectTools } from "../src/skill-publish/manifest";
import { main } from "../src/skill-publish";
import type { Manifest, PluginManifest } from "../src/skill-publish/types";

let tmp: string;
let origDgSkillsDir: string | undefined;
let schemaRoot: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "skill-publish-test-"));
	schemaRoot = join(tmp, "installed-skills");
	mkdirSync(join(schemaRoot, "skill-publish", "references"), { recursive: true });
	copySchemaInto(schemaRoot);
	origDgSkillsDir = process.env.DG_SKILLS_DIR;
	process.env.DG_SKILLS_DIR = schemaRoot;
});

afterEach(() => {
	if (origDgSkillsDir === undefined) delete process.env.DG_SKILLS_DIR;
	else process.env.DG_SKILLS_DIR = origDgSkillsDir;
	rmSync(tmp, { recursive: true, force: true });
});

const REPO_SKILL_PUBLISH = join(import.meta.dir, "..", "..", "..", "plugins", "dg", "skills", "skill-publish");

function copySchemaInto(root: string): void {
	for (const file of ["manifest.schema.json", "plugin.schema.json"]) {
		writeFileSync(
			join(root, "skill-publish", "references", file),
			readFileSync(join(REPO_SKILL_PUBLISH, "references", file), "utf-8"),
		);
	}
}

function writeCli(dir: string, name: string, content: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

function buildManifest(overrides: Partial<Manifest> = {}): Manifest {
	return {
		name: "myserver",
		version: "1.0.0",
		description: "a test server",
		recipe: "use the tools",
		tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: {}, required: [] } }],
		...overrides,
	};
}

function writeManifestFile(manifest: Manifest): string {
	const path = join(tmp, "m.publish.json");
	writeFileSync(path, JSON.stringify(manifest));
	return path;
}

function writeFakeSkill(dir: string, name: string, description = "A fake skill."): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
	return skillDir;
}

function writePluginManifestFile(dir: string, overrides: Partial<PluginManifest> = {}): string {
	const manifest: PluginManifest = { name: "test-plugin", description: "a test plugin", skills: [], ...overrides };
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "m.plugin.json");
	writeFileSync(path, JSON.stringify(manifest));
	return path;
}

function initCheckout(root: string): void {
	mkdirSync(join(root, "plugins", "dg", ".claude-plugin"), { recursive: true });
	writeFileSync(join(root, "plugins", "dg", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dg" }));
	mkdirSync(join(root, "plugins", "dg", "skills"), { recursive: true });
}

async function captureStdout<T>(fn: () => T | Promise<T>): Promise<{ result: T; out: string }> {
	const logs: string[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		logs.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		const result = await fn();
		return { result, out: logs.join("") };
	} finally {
		process.stdout.write = orig;
	}
}

describe("analyze", () => {
	test("accepts a Bun-TS source file", () => {
		const path = writeCli(tmp, "tool.ts", "#!/usr/bin/env bun\nconsole.log(1);\n");
		expect(analyzeSource(path)).toEqual({ publishable: true, issues: [], routing: "bun-ts" });
	});

	test("rejects a shell script", () => {
		const path = writeCli(tmp, "tool.sh", "#!/bin/bash\necho hi\n");
		const result = analyzeSource(path);
		expect(result.publishable).toBe(false);
		expect(result.routing).toBe("bun-ts");
	});

	test("rejects a Python script", () => {
		const path = writeCli(tmp, "tool.py", "#!/usr/bin/env python\nprint(1)\n");
		expect(analyzeSource(path).publishable).toBe(false);
	});

	test("flags a native addon dependency as publishable-with-constraints", () => {
		const dir = join(tmp, "native-proj");
		mkdirSync(join(dir, "node_modules", "some-native"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "some-native": "1.0.0" } }));
		writeFileSync(join(dir, "node_modules", "some-native", "package.json"), JSON.stringify({ gypfile: true }));
		const path = writeCli(dir, "tool.ts", "#!/usr/bin/env bun\nconsole.log(1);\n");
		const result = analyzeSource(path);
		expect(result.routing).toBe("native-addon");
		expect(result.publishable).toBe(true);
	});

	test("main() exits 1 for a missing file", async () => {
		const code = await main(["analyze", join(tmp, "missing.ts")]);
		expect(code).toBe(1);
	});
});

describe("manifest draft", () => {
	test("introspectTools falls back to a single run tool with no COMMANDS map", () => {
		const path = writeCli(tmp, "plain.ts", "console.log('hi');\n");
		const tools = introspectTools(path);
		expect(tools).toEqual([
			{
				name: "run",
				description: "Run the tool",
				inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" } } }, required: [] },
			},
		]);
	});

	test("introspectTools extracts named COMMANDS entries", () => {
		const path = writeCli(
			tmp,
			"withcmds.ts",
			'const COMMANDS = {\n  foo: { summary: "does foo", run: cmdFoo },\n  bar: { summary: "does bar", run: cmdBar },\n};\n',
		);
		const tools = introspectTools(path);
		expect(tools.map((t) => t.name).sort()).toEqual(["bar", "foo"]);
	});

	test("drafts a manifest with the local-zone fields omitted and prints the path", async () => {
		const path = writeCli(tmp, "my-tool.ts", "#!/usr/bin/env bun\nconsole.log(1);\n");
		const { result: code, out } = await captureStdout(() => main(["manifest", "draft", path, "--out", tmp]));
		expect(code).toBe(0);
		const manifestPath = out.trim();
		expect(existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		expect(manifest.name).toBe("my-tool");
		expect("cli_path" in manifest).toBe(false);
	});
});

describe("manifest validate", () => {
	test("a well-formed manifest passes", async () => {
		const path = writeManifestFile(buildManifest());
		expect(await main(["manifest", "validate", path])).toBe(0);
	});

	test("rejects an unsafe name via the schema", async () => {
		const path = writeManifestFile(buildManifest({ name: "Not Valid" }));
		expect(await main(["manifest", "validate", path])).toBe(1);
	});

	test("rejects a tool named <server>_guide", async () => {
		const manifest = buildManifest({
			tools: [{ name: "myserver_guide", description: "x", inputSchema: { type: "object" } }],
		});
		const path = writeManifestFile(manifest);
		expect(await main(["manifest", "validate", path])).toBe(1);
	});

	test("rejects long_running without resume_contract", async () => {
		const manifest = buildManifest({
			tools: [{ name: "slow", description: "x", inputSchema: { type: "object" }, long_running: true }],
		});
		const path = writeManifestFile(manifest);
		expect(await main(["manifest", "validate", path])).toBe(1);
	});
});

describe("generate", () => {
	test("writes server.ts and package.json for the manifest", async () => {
		const path = writeManifestFile(buildManifest());
		const outDir = join(tmp, "out");
		const { result: code, out } = await captureStdout(() => main(["generate", path, "--out-dir", outDir]));
		expect(code).toBe(0);
		expect(out.trim()).toBe(outDir);
		expect(existsSync(join(outDir, "server.ts"))).toBe(true);
		const pkg = JSON.parse(readFileSync(join(outDir, "package.json"), "utf-8"));
		expect(pkg.name).toBe("myserver-mcp-server");
	});

	test("toPortable strips every local-zone field", () => {
		const manifest = buildManifest({ cli_path: "/x/y.ts", author_notes: "secret plan" });
		const portable = toPortable(manifest);
		expect("cli_path" in portable).toBe(false);
		expect("author_notes" in portable).toBe(false);
		expect(portable.name).toBe("myserver");
	});

	test("rejects an unsafe manifest name", async () => {
		const path = writeManifestFile(buildManifest({ name: "Not Valid" }));
		expect(await main(["generate", path, "--out-dir", join(tmp, "out")])).toBe(1);
	});

	test("without --repo-owner the generated server emits the zip-build update stub", () => {
		const path = writeManifestFile(buildManifest());
		const outDir = join(tmp, "out");
		expect(cmdGenerate(["generate", path, "--out-dir", outDir].slice(1))).toBe(0);
		const src = readFileSync(join(outDir, "server.ts"), "utf-8");
		expect(src).toContain("cmdUpdate");
		expect(src).toMatch(/not configured.*zip build/i);
	});

	test("with --repo-owner the generated server embeds the full self-update subcommand", () => {
		const path = writeManifestFile(buildManifest());
		const outDir = join(tmp, "out");
		expect(cmdGenerate(["generate", path, "--out-dir", outDir, "--repo-owner", "fake-owner"].slice(1))).toBe(0);
		const src = readFileSync(join(outDir, "server.ts"), "utf-8");
		expect(src).toContain("SHA256SUMS");
		expect(src).toContain("renameSync");
		expect(src).toContain("stripAuthOnRedirect");
		expect(src).toMatch(/non-HTTPS/i);
	});

	describe("embedded update helpers (dynamic import)", () => {
		async function generateServerForImport(): Promise<string> {
			const path = writeManifestFile(buildManifest());
			const outDir = join(tmp, "out-import");
			const code = cmdGenerate(["generate", path, "--out-dir", outDir, "--repo-owner", "fake-owner"].slice(1));
			if (code !== 0) throw new Error("generate failed");
			return join(outDir, "server.ts");
		}

		test("assertHttpsUrl accepts https and rejects http", async () => {
			const serverPath = await generateServerForImport();
			const mod = (await import(serverPath)) as { assertHttpsUrl: (url: string) => void };
			expect(() => mod.assertHttpsUrl("https://api.github.com/repos/x/y")).not.toThrow();
			expect(() => mod.assertHttpsUrl("http://evil.example.com/bad")).toThrow(/non-HTTPS/i);
		});

		test("authHeadersFor strips Authorization for a non-api host", async () => {
			const serverPath = await generateServerForImport();
			const mod = (await import(serverPath)) as {
				authHeadersFor: (url: string, apiHost: string, token: string | undefined, strip: boolean) => Record<string, string>;
			};
			const apiHeaders = mod.authHeadersFor("https://api.github.com/x", "api.github.com", "tok", true);
			expect(apiHeaders.Authorization).toBe("Bearer tok");
			const cdnHeaders = mod.authHeadersFor("https://objects.githubusercontent.com/x", "api.github.com", "tok", true);
			expect(cdnHeaders.Authorization).toBeUndefined();
		});

		test("verifyAsset throws on a hash mismatch and on no matching entry", async () => {
			const serverPath = await generateServerForImport();
			const mod = (await import(serverPath)) as {
				verifyAsset: (bytes: Buffer, sums: string, name: string) => void;
			};
			const bytes = Buffer.from("fake binary content");
			const { createHash } = await import("node:crypto");
			const hash = createHash("sha256").update(bytes).digest("hex");
			expect(() => mod.verifyAsset(bytes, `${hash}  myserver-linux\n`, "myserver-linux")).not.toThrow();
			const flipped = Buffer.from(bytes);
			flipped[0] ^= 0xff;
			expect(() => mod.verifyAsset(flipped, `${hash}  myserver-linux\n`, "myserver-linux")).toThrow(/mismatch/i);
			expect(() => mod.verifyAsset(bytes, `${hash}  other-name\n`, "myserver-linux")).toThrow(/does not contain/i);
		});

		test("atomicSwap writes the target and cleans up on a failed rename", async () => {
			const serverPath = await generateServerForImport();
			const mod = (await import(serverPath)) as {
				atomicSwap: (tmpPath: string, selfPath: string, bytes: Buffer) => void;
			};
			const dir = join(tmp, "swap");
			mkdirSync(dir, { recursive: true });
			const tmpPath = join(dir, "bin.new");
			const selfPath = join(dir, "bin");
			mod.atomicSwap(tmpPath, selfPath, Buffer.from("v2"));
			expect(readFileSync(selfPath).toString()).toBe("v2");
			expect(existsSync(tmpPath)).toBe(false);

			const badSelfPath = join(dir, "missing-subdir", "bin");
			expect(() => mod.atomicSwap(tmpPath, badSelfPath, Buffer.from("x"))).toThrow();
			expect(existsSync(tmpPath)).toBe(false);
		});
	});
});

describe("checkout helpers", () => {
	test("findSourceCheckoutPluginRoot walks up to the nearest plugins/dg", () => {
		const root = join(tmp, "repo");
		initCheckout(root);
		const nested = join(root, "a", "b", "c");
		mkdirSync(nested, { recursive: true });
		expect(findSourceCheckoutPluginRoot(nested)).toBe(join(root, "plugins", "dg"));
	});

	test("findSourceCheckoutPluginRoot returns undefined outside any checkout", () => {
		expect(findSourceCheckoutPluginRoot(tmp)).toBeUndefined();
	});

	test("assertNotInstalledCache refuses a path under ~/.claude/plugins/cache", () => {
		const home = join(tmp, "home");
		const cachePath = join(home, ".claude", "plugins", "cache", "market", "dg", "1.0.0", "plugins", "dg");
		expect(() => assertNotInstalledCache(cachePath, home)).toThrow(/installed plugin cache/);
		expect(() => assertNotInstalledCache(join(tmp, "repo", "plugins", "dg"), home)).not.toThrow();
	});

	test("assertNotSelfMove refuses identical and nested paths", () => {
		const a = join(tmp, "skills", "foo");
		expect(() => assertNotSelfMove(a, a)).toThrow(/onto itself/);
		expect(() => assertNotSelfMove(a, join(a, "nested"))).toThrow();
		expect(() => assertNotSelfMove(join(tmp, "other"), a)).not.toThrow();
	});
});

describe("plugin draft", () => {
	test("scaffolds a manifest with skills[], omits version, and prints the path", async () => {
		const { result: code, out } = await captureStdout(() =>
			main(["plugin", "draft", "my-plugin", "--skill", "foo", "--skill", "bar", "--out", tmp]),
		);
		expect(code).toBe(0);
		const manifest = JSON.parse(readFileSync(out.trim(), "utf-8"));
		expect(manifest.name).toBe("my-plugin");
		expect(manifest.skills).toEqual(["foo", "bar"]);
		expect("version" in manifest).toBe(false);
	});
});

describe("plugin validate", () => {
	test("a valid manifest with a path-based skill passes", async () => {
		const skillDir = writeFakeSkill(tmp, "my-skill");
		const path = writePluginManifestFile(tmp, { skills: [skillDir] });
		expect(await main(["plugin", "validate", path])).toBe(0);
	});

	test("rejects a bad name", async () => {
		const skillDir = writeFakeSkill(tmp, "my-skill");
		const path = writePluginManifestFile(tmp, { name: "Not_Valid", skills: [skillDir] });
		expect(await main(["plugin", "validate", path])).toBe(1);
	});

	test("rejects an empty skills[]", async () => {
		const path = writePluginManifestFile(tmp, { skills: [] });
		expect(await main(["plugin", "validate", path])).toBe(1);
	});

	test("rejects a skill path with no SKILL.md", async () => {
		const missing = join(tmp, "nope");
		const path = writePluginManifestFile(tmp, { skills: [missing] });
		const { result: code } = await captureStdout(() => main(["plugin", "validate", path]));
		expect(code).toBe(1);
	});
});

const SRC_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

/** Spawn the real source CLI with piped stdin — `main()` cannot be driven in-process because
 * `readStdinLine()` reads `Bun.stdin`, which bun does not allow a test to redefine. */
async function runSkillPublishCli(
	args: string[],
	opts: { input?: string; cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn([process.execPath, "run", SRC_ENTRY, "skill-publish", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: opts.input === undefined ? "ignore" : Buffer.from(opts.input),
		cwd: opts.cwd,
		env: { ...process.env, DG_SKILLS_DIR: schemaRoot, ...opts.env },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

describe("plugin generate", () => {
	test("ships an additive copy: writes the new skill, leaves an existing one untouched", async () => {
		const root = join(tmp, "repo");
		initCheckout(root);
		const existingSkill = join(root, "plugins", "dg", "skills", "existing");
		mkdirSync(existingSkill, { recursive: true });
		writeFileSync(join(existingSkill, "SKILL.md"), "---\nname: existing\n---\n# existing\n");

		const skillDir = writeFakeSkill(tmp, "greet-skill");
		const manifestPath = writePluginManifestFile(tmp, { skills: [skillDir] });

		const { code } = await runSkillPublishCli(
			["plugin", "generate", manifestPath, "--root", join(root, "plugins", "dg")],
			{ input: "y\n" },
		);
		expect(code).toBe(0);

		expect(existsSync(join(root, "plugins", "dg", "skills", "greet-skill", "SKILL.md"))).toBe(true);
		expect(existsSync(join(existingSkill, "SKILL.md"))).toBe(true);
		expect(existsSync(join(root, "plugins", "dg", ".claude-plugin", "plugin.json"))).toBe(true);
		const pluginJson = JSON.parse(readFileSync(join(root, "plugins", "dg", ".claude-plugin", "plugin.json"), "utf-8"));
		expect(pluginJson).toEqual({ name: "dg" });
	});

	test("gate 'n' writes nothing", async () => {
		const root = join(tmp, "repo");
		initCheckout(root);
		const skillDir = writeFakeSkill(tmp, "greet-skill");
		const manifestPath = writePluginManifestFile(tmp, { skills: [skillDir] });

		const { code } = await runSkillPublishCli(
			["plugin", "generate", manifestPath, "--root", join(root, "plugins", "dg")],
			{ input: "n\n" },
		);
		expect(code).toBe(1);
		expect(existsSync(join(root, "plugins", "dg", "skills", "greet-skill"))).toBe(false);
	});

	test("a planted secret hard-blocks generate before the gate", async () => {
		const root = join(tmp, "repo");
		initCheckout(root);
		const skillDir = join(tmp, "secret-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: secret-skill\n---\n# secret-skill\n\nAKIAABCDEFGHIJKLMNOP\n");
		const manifestPath = writePluginManifestFile(tmp, { skills: [skillDir] });

		const code = await main(["plugin", "generate", manifestPath, "--root", join(root, "plugins", "dg")]);
		expect(code).toBe(1);
		expect(existsSync(join(root, "plugins", "dg", "skills", "secret-skill"))).toBe(false);
	});

	test("refuses a self-move when the source already resolves inside the destination tree", async () => {
		const root = join(tmp, "repo");
		initCheckout(root);
		const already = join(root, "plugins", "dg", "skills", "already-there");
		mkdirSync(already, { recursive: true });
		writeFileSync(join(already, "SKILL.md"), "---\nname: already-there\n---\n# x\n");
		const manifestPath = writePluginManifestFile(tmp, { skills: [already] });

		const code = await main(["plugin", "generate", manifestPath, "--root", join(root, "plugins", "dg")]);
		expect(code).toBe(1);
	});

	test("refuses to write into an installed plugin cache path", async () => {
		const fakeHome = join(tmp, "home");
		const cacheRoot = join(fakeHome, ".claude", "plugins", "cache", "market", "dg", "1.0.0", "plugins", "dg");
		mkdirSync(join(cacheRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(join(cacheRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dg" }));
		const skillDir = writeFakeSkill(tmp, "greet-skill");
		const manifestPath = writePluginManifestFile(tmp, { skills: [skillDir] });

		const { code } = await runSkillPublishCli(["plugin", "generate", manifestPath, "--root", cacheRoot], {
			input: "y\n",
			env: { HOME: fakeHome },
		});
		expect(code).toBe(1);
		expect(existsSync(join(cacheRoot, "skills", "greet-skill"))).toBe(false);
	});

	test("without --root, discovers plugins/dg by walking up from the cwd", async () => {
		const root = join(tmp, "repo");
		initCheckout(root);
		const nested = join(root, "nested", "deeper");
		mkdirSync(nested, { recursive: true });
		const skillDir = writeFakeSkill(tmp, "greet-skill");
		const manifestPath = writePluginManifestFile(tmp, { skills: [skillDir] });

		const { code } = await runSkillPublishCli(["plugin", "generate", manifestPath], { input: "y\n", cwd: nested });
		expect(code).toBe(0);
		expect(existsSync(join(root, "plugins", "dg", "skills", "greet-skill", "SKILL.md"))).toBe(true);
	});
});
