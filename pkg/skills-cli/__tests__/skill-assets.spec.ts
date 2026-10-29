import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSkillAsset } from "../src/utils/skill-assets";
import { proxyFixtures, relocatedProxyCli, runProxyProcess } from "./proxy-fixtures";

let installation: ReturnType<typeof proxyFixtures>;
let probe: string[];
beforeAll(() => {
	installation = proxyFixtures();
	probe = [...relocatedProxyCli(installation), "prototype", "components"];
}, 120000);
afterAll(() => installation.cleanup());

let fixture: ReturnType<typeof proxyFixtures>;
beforeEach(() => {
	fixture = proxyFixtures();
});
afterEach(() => fixture.cleanup());
function protoAssets(root: string): string {
	const directory = join(root, "proto", "assets");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "dg-icons.js"), "icons");
	return directory;
}

function asset(root: string, content: string): string {
	const path = join(root, "proxy", "references", "guide.md");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	return path;
}

describe("resolveSkillAsset", () => {
	test("honors an explicit root over the configured root without cache fallback", () => {
		const explicit = join(fixture.root, "explicit");
		const configured = join(fixture.root, "configured");
		const explicitPath = asset(explicit, "explicit");
		asset(configured, "configured");
		expect(
			resolveSkillAsset("proxy", "references/guide.md", {
				skillsRoot: explicit,
				configuredSkillsRoot: configured,
			}),
		).toBe(explicitPath);
		expect(() =>
			resolveSkillAsset("proxy", "references/guide.md", {
				skillsRoot: join(fixture.root, "missing"),
				configuredSkillsRoot: configured,
			}),
		).toThrow(/Skill asset not found/);
	});

	test("chooses explicit, configured, then real source install roots", () => {
		const explicit = join(fixture.root, "explicit skills");
		const configured = join(fixture.root, "configured skills");
		const source = join(fixture.root, "source skills");
		const a = asset(explicit, "explicit");
		const b = asset(configured, "configured");
		const c = asset(source, "source");
		expect(
			resolveSkillAsset("proxy", "references/guide.md", {
				skillsRoot: explicit,
				configuredSkillsRoot: configured,
				sourceSkillsRoot: source,
			}),
		).toBe(a);
		expect(
			resolveSkillAsset("proxy", "references/guide.md", {
				configuredSkillsRoot: configured,
				sourceSkillsRoot: source,
			}),
		).toBe(b);
		expect(
			resolveSkillAsset("proxy", "references/guide.md", {
				sourceSkillsRoot: source,
			}),
		).toBe(c);
		expect(resolveSkillAsset("proxy", "", { skillsRoot: explicit })).toBe(
			join(explicit, "proxy"),
		);
	});

	test("keeps relocated assets independent of the working directory", () => {
		const installed = join(fixture.root, "moved plugin", "skills");
		const path = asset(installed, "relocated reference");
		expect(
			resolveSkillAsset("proxy", "references/guide.md", {
				skillsRoot: installed,
			}),
		).toBe(path);
	});

	test("reports missing explicitly selected assets instead of falling through to a cache", () => {
		const installed = join(fixture.root, "missing install");
		asset(join(fixture.root, "old cache"), "stale");
		expect(() =>
			resolveSkillAsset("proxy", "references/guide.md", {
				skillsRoot: installed,
				sourceSkillsRoot: join(fixture.root, "old cache"),
			}),
		).toThrow(/Skill asset not found: proxy\/references\/guide\.md/);
	});

	test("rejects virtual compiled paths instead of treating them as installed resources", () => {
		expect(() =>
			resolveSkillAsset("proxy", "SKILL.md", {
				sourceSkillsRoot: "/$bunfs/root/plugins/dg/skills",
			}),
		).toThrow(/real filesystem path/);
	});

	test.each(["../private", "/absolute", "proxy/../../private"])(
		"rejects escaping skill names %s",
		(skill) => {
			expect(() =>
				resolveSkillAsset(skill, "SKILL.md", { skillsRoot: fixture.root }),
			).toThrow(/Invalid skill name/);
		},
	);

	test.each(["../private", "/absolute", "references/../../private"])(
		"rejects escaping asset paths %s",
		(path) => {
			asset(fixture.root, "owned");
			mkdirSync(join(fixture.root, "private"), { recursive: true });
			writeFileSync(join(fixture.root, "private", "SKILL.md"), "private");
			expect(() =>
				resolveSkillAsset("proxy", path, { skillsRoot: fixture.root }),
			).toThrow(/must stay inside proxy/);
		},
	);

	test("rejects an asset symlink that escapes the selected skill directory", () => {
		const outside = join(fixture.root, "outside.md");
		writeFileSync(outside, "private fixture");
		const root = join(fixture.root, "installed skills");
		asset(root, "owned");
		symlinkSync(outside, join(root, "proxy", "references", "escaped.md"));
		expect(() =>
			resolveSkillAsset("proxy", "references/escaped.md", { skillsRoot: root }),
		).toThrow(/escapes/);
	});

	test.each([
		"/$bunfs/root/skills",
		"C:\\$bunfs\\root\\skills",
		"/~BUN/root/skills",
		"C:\\~BUN\\root\\skills",
	])("rejects virtual installed root %s", async (skillsRoot) => {
		const result = await runProxyProcess(
			probe,
			fixture,
			{ DG_SKILLS_DIR: skillsRoot },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("real filesystem path");
	});

	test.each(["DG_SKILLS_DIR", "DG_SKILLS_DEST"])(
		"loads real bundled resources selected by %s",
		async (variable) => {
			const root = join(fixture.root, "configured ' installed skills");
			const path = protoAssets(root);
			const result = await runProxyProcess(probe, fixture, {
				[variable]: root,
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe(path);
		},
	);

	test("honors the configured root over the destination root without cache fallback", async () => {
		const configured = join(fixture.root, "configured");
		const destination = join(fixture.root, "destination");
		const configuredPath = protoAssets(configured);
		protoAssets(destination);
		const env = { DG_SKILLS_DIR: configured, DG_SKILLS_DEST: destination };
		const automatic = await runProxyProcess(probe, fixture, env);
		expect(automatic.exitCode, automatic.stderr).toBe(0);
		expect(automatic.stdout.trim()).toBe(configuredPath);
		const missing = await runProxyProcess(probe, fixture, {
			...env,
			DG_SKILLS_DIR: join(fixture.root, "missing"),
		});
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr).toContain("Skill asset not found");
	});

	test("loads DG_HOME resources before plugin roots and defaults to the isolated HOME", async () => {
		const dgHome = join(fixture.root, "dg ' home");
		const configuredPath = protoAssets(join(dgHome, "skills"));
		const homePath = protoAssets(join(fixture.home, ".dg", "skills"));
		const configured = await runProxyProcess(probe, fixture, {
			DG_HOME: dgHome,
		});
		expect(configured.exitCode, configured.stderr).toBe(0);
		expect(configured.stdout.trim()).toBe(configuredPath);
		const defaults = await runProxyProcess(probe, fixture);
		expect(defaults.exitCode, defaults.stderr).toBe(0);
		expect(defaults.stdout.trim()).toBe(homePath);
	});

	for (const variable of [
		"DG_PLUGIN_ROOT",
		"CLAUDE_PLUGIN_ROOT",
		"CODEX_PLUGIN_ROOT",
	]) {
		test.each(["skills", "plugins/dg/skills"])(
			`loads relocated bundled ${variable}/%s resources`,
			async (layout) => {
				const plugin = join(fixture.root, "moved ' plugin");
				const path = protoAssets(join(plugin, layout));
				const result = await runProxyProcess(probe, fixture, {
					[variable]: plugin,
				});
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe(path);
			},
		);
	}

	test.each(["skills", "plugins/dg/skills"])(
		"loads %s beside a real source entrypoint outside the checkout",
		async (layout) => {
			const path = asset(join(fixture.root, layout), "source installation");
			const source = join(fixture.root, "nested", "entry.ts");
			mkdirSync(join(source, ".."), { recursive: true });
			writeFileSync(
				source,
				`import { resolveSkillAsset } from ${JSON.stringify(join(import.meta.dir, "../src/utils/skill-assets.ts"))}; console.log(JSON.stringify(resolveSkillAsset('proxy', 'references/guide.md')));\n`,
			);
			const result = await runProxyProcess([process.execPath, source], fixture);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toBe(path);
		},
	);

	test("bundled execution with no installed assets reports an actionable error", async () => {
		const result = await runProxyProcess(probe, fixture);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("DG_SKILLS_DIR");
		expect(result.stderr).not.toMatch(/\$bunfs|~BUN/);
	});
});
