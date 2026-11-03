import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { firstLine, type RecommendedPlugin } from "./recommended-plugins";

type SkillPlan = { name: string; files: { from: string; rel: string }[] };

const REGULAR_MODES = new Set(["100644", "100755"]);
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

function gitBinary(): string {
	const found = Bun.which("git");
	if (!found) throw new Error("git not found");
	return found;
}

function git(binary: string, checkout: string, args: string[]): string {
	const result = spawnSync(binary, ["-C", checkout, ...args], {
		cwd: tmpdir(),
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(firstLine(result.stderr) || `git ${args[0]} exited ${result.status}`);
	}
	return result.stdout;
}

function declaredSkillDirs(plugin: RecommendedPlugin, checkout: string): string[] {
	if (plugin.skills) return plugin.skills;
	const manifest = JSON.parse(
		readFileSync(join(checkout, ".claude-plugin", "plugin.json"), "utf8"),
	) as { skills?: unknown };
	if (!Array.isArray(manifest.skills)) {
		throw new Error("no skills declared");
	}
	return manifest.skills.map(String);
}

function planSkill(
	plugin: RecommendedPlugin,
	checkout: string,
	dir: string,
	tracked: { mode: string; path: string }[],
): SkillPlan {
	const source = resolve(checkout, dir);
	const inside = relative(checkout, source);
	if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
		throw new Error(`skill path ${dir} leaves the repository`);
	}
	const name = inside === "" ? plugin.name : basename(source);
	if (!SKILL_NAME.test(name)) throw new Error(`refuses skill name ${name}`);
	const posixInside = inside.split(sep).join("/");
	const prefix = inside === "" ? "" : `${posixInside}/`;
	const root = tracked.find((entry) => entry.path === posixInside);
	if (root && !REGULAR_MODES.has(root.mode)) throw new Error(`refuses ${modeName(root.mode)} ${root.path}`);
	const selected = tracked.filter((entry) => {
		if (!entry.path.startsWith(prefix)) return false;
		if (inside !== "") return true;
		return !entry.path.startsWith(".");
	});
	for (const entry of selected) {
		if (!REGULAR_MODES.has(entry.mode)) throw new Error(`refuses ${modeName(entry.mode)} ${entry.path}`);
	}
	const files = selected.map((entry) => ({
		from: join(checkout, entry.path),
		rel: entry.path.slice(prefix.length),
	}));
	if (!files.some((file) => file.rel === "SKILL.md")) throw new Error(`${name} has no SKILL.md`);
	return { name, files };
}

function modeName(mode: string): string {
	if (mode === "120000") return "symlink";
	if (mode === "160000") return "submodule";
	return `mode ${mode} entry`;
}

function stageSkills(plans: SkillPlan[], staging: string): void {
	for (const plan of plans) {
		for (const { from, rel } of plan.files) {
			const to = join(staging, plan.name, rel);
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
			chmodSync(to, 0o644);
		}
	}
}

export function installRecommendedSkillsOnly(
	plugin: RecommendedPlugin,
	dest: string,
	dgSkillNames: Set<string>,
	log: (line: string) => void,
): string[] {
	const checkout = mkdtempSync(join(tmpdir(), `dg-plugin-${plugin.name}-`));
	let staging: string | undefined;
	let swapped = false;
	try {
		const binary = gitBinary();
		git(binary, checkout, ["init", "-q"]);
		git(binary, checkout, [
			"fetch",
			"-q",
			"--depth",
			"1",
			`https://github.com/${plugin.repo}.git`,
			plugin.sha,
		]);
		git(binary, checkout, ["checkout", "-q", "FETCH_HEAD"]);
		const head = git(binary, checkout, ["rev-parse", "HEAD"]).trim();
		if (head !== plugin.sha) throw new Error(`fetched ${head}, expected ${plugin.sha}`);
		const tracked = git(binary, checkout, ["ls-files", "-s", "-z"])
			.split("\0")
			.filter(Boolean)
			.map((line) => ({ mode: line.slice(0, 6), path: line.split("\t")[1] ?? "" }));
		const plans = declaredSkillDirs(plugin, checkout).map((dir) =>
			planSkill(plugin, checkout, dir, tracked),
		);
		const installable = plans.filter((plan) => {
			if (!dgSkillNames.has(plan.name)) return true;
			log(`skipped ${plan.name} (dg ships its own)`);
			return false;
		});
		mkdirSync(dest, { recursive: true });
		staging = mkdtempSync(join(dest, ".dg-recommended-"));
		stageSkills(installable, staging);
		swapped = true;
		for (const plan of installable) {
			rmSync(join(dest, plan.name), { recursive: true, force: true });
			renameSync(join(staging, plan.name), join(dest, plan.name));
		}
		return installable.flatMap((plan) => plan.files.map((file) => `${plan.name}/${file.rel}`));
	} catch (error) {
		const reason = firstLine(error instanceof Error ? error.message : String(error));
		log(`⚠ ${plugin.name} ${swapped ? "failed" : "skipped"}: ${reason}`);
		return [];
	} finally {
		rmSync(checkout, { recursive: true, force: true });
		if (staging) rmSync(staging, { recursive: true, force: true });
	}
}
