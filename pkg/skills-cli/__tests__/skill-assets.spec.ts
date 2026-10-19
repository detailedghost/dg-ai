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
import { proxyFixtures, runProxyProcess } from "./proxy-fixtures";

let installation: ReturnType<typeof proxyFixtures>;
let probe: string;
beforeAll(() => {
	installation = proxyFixtures();
	const source = join(installation.root, "asset-probe.ts");
	writeFileSync(
		source,
		`import { resolveSkillAsset } from ${JSON.stringify(join(import.meta.dir, "../src/utils/skill-assets.ts"))};\ntry { console.log(JSON.stringify(resolveSkillAsset('proxy', 'references/guide.md', JSON.parse(process.argv[2] || '{}')))); } catch (error) { console.error(String(error)); process.exit(1); }\n`,
	);
	probe = join(installation.root, "relocated ' asset probe");
	const build = Bun.spawnSync(
		[process.execPath, "build", source, "--compile", "--outfile", probe],
		{ env: installation.env(), stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}, 120000);
afterAll(() => installation.cleanup());

let fixture: ReturnType<typeof proxyFixtures>;
beforeEach(() => {
	fixture = proxyFixtures();
});
afterEach(() => fixture.cleanup());
function asset(root: string, content: string): string {
	const path = join(root, "proxy", "references", "guide.md");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	return path;
}

describe("resolveSkillAsset", () => {
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
			[probe, JSON.stringify({ skillsRoot })],
			fixture,
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("real filesystem path");
	});

	test.each(["DG_SKILLS_DIR", "DG_SKILLS_DEST"])(
		"loads real compiled resources selected by %s",
		async (variable) => {
			const root = join(fixture.root, "configured ' installed skills");
			const path = asset(root, "configured");
			const result = await runProxyProcess([probe], fixture, {
				[variable]: root,
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toBe(path);
		},
	);

	test("honors explicit root over both configured environment variables without cache fallback", async () => {
		const explicit = join(fixture.root, "explicit");
		const configured = join(fixture.root, "configured");
		const destination = join(fixture.root, "destination");
		const explicitPath = asset(explicit, "explicit");
		const configuredPath = asset(configured, "configured");
		asset(destination, "destination");
		const env = { DG_SKILLS_DIR: configured, DG_SKILLS_DEST: destination };
		const selected = await runProxyProcess(
			[probe, JSON.stringify({ skillsRoot: explicit })],
			fixture,
			env,
		);
		expect(selected.exitCode, selected.stderr).toBe(0);
		expect(JSON.parse(selected.stdout)).toBe(explicitPath);
		const automatic = await runProxyProcess([probe], fixture, env);
		expect(automatic.exitCode, automatic.stderr).toBe(0);
		expect(JSON.parse(automatic.stdout)).toBe(configuredPath);
		const missing = await runProxyProcess(
			[probe, JSON.stringify({ skillsRoot: join(fixture.root, "missing") })],
			fixture,
			env,
		);
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr).toContain("Skill asset not found");
	});

	test("loads DG_HOME resources before plugin roots and defaults to the isolated HOME", async () => {
		const dgHome = join(fixture.root, "dg ' home");
		const configuredPath = asset(join(dgHome, "skills"), "dg home");
		const homePath = asset(join(fixture.home, ".dg", "skills"), "home default");
		const configured = await runProxyProcess([probe], fixture, {
			DG_HOME: dgHome,
		});
		expect(configured.exitCode, configured.stderr).toBe(0);
		expect(JSON.parse(configured.stdout)).toBe(configuredPath);
		const defaults = await runProxyProcess([probe], fixture);
		expect(defaults.exitCode, defaults.stderr).toBe(0);
		expect(JSON.parse(defaults.stdout)).toBe(homePath);
	});

	for (const variable of [
		"DG_PLUGIN_ROOT",
		"CLAUDE_PLUGIN_ROOT",
		"CODEX_PLUGIN_ROOT",
	]) {
		test.each(["skills", "plugins/dg/skills"])(
			`loads relocated compiled ${variable}/%s resources`,
			async (layout) => {
				const plugin = join(fixture.root, "moved ' plugin");
				const path = asset(join(plugin, layout), "relocated plugin");
				const result = await runProxyProcess([probe], fixture, {
					[variable]: plugin,
				});
				expect(result.exitCode, result.stderr).toBe(0);
				expect(JSON.parse(result.stdout)).toBe(path);
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

	test("compiled execution with no installed assets reports an actionable error", async () => {
		const result = await runProxyProcess([probe], fixture);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("DG_SKILLS_DIR");
		expect(result.stderr).not.toMatch(/\$bunfs|~BUN/);
	});
});
