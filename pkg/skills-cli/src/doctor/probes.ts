import {
	accessSync,
	constants,
	existsSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { claudePluginSkillsDirs } from "@dg/common/node";
import { compareVersions, versionGte } from "../utils/lib";

export const CLI_PATH = "~/.dg/bin/dg-skills";
const VERSION = /\d+\.\d+(?:\.\d+)?/;

export function whichBinary(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	return Bun.which(name, env.PATH === undefined ? {} : { PATH: env.PATH });
}

export function parseVersion(text: string): string | null {
	return VERSION.exec(text)?.[0] ?? null;
}

export function toolVersion(binary: string): string | null {
	try {
		const result = Bun.spawnSync([binary, "--version"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5000,
		});
		return parseVersion(
			`${result.stdout.toString()}\n${result.stderr.toString()}`,
		);
	} catch {
		return null;
	}
}

export function isOlder(version: string, minimum: string): boolean {
	return !versionGte(version, minimum);
}

export interface WritableResult {
	writable: boolean;
	at: string;
	reason: string;
	kind?: "not-directory" | "not-writable";
}

export function writableDirectory(path: string): WritableResult {
	let at = path;
	while (!existsSync(at)) {
		const parent = dirname(at);
		if (parent === at) break;
		at = parent;
	}
	try {
		if (!statSync(at).isDirectory())
			return {
				writable: false,
				at,
				reason: `${at} is not a directory`,
				kind: "not-directory",
			};
		accessSync(at, constants.W_OK | constants.X_OK);
		return { writable: true, at, reason: "" };
	} catch {
		return {
			writable: false,
			at,
			reason: `${at} is not writable`,
			kind: "not-writable",
		};
	}
}

export function allowRuleFor(sub: string): string {
	return `Bash(${CLI_PATH} ${sub}:*)`;
}

export type AllowRules = { rules: string[] } | { error: string };

export function readAllowRules(home: string): AllowRules {
	let text: string;
	try {
		text = readFileSync(join(home, ".claude", "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { rules: [] };
		return { error: (error as Error).message };
	}
	try {
		const allow = JSON.parse(text)?.permissions?.allow;
		return {
			rules: Array.isArray(allow)
				? allow.filter((rule): rule is string => typeof rule === "string")
				: [],
		};
	} catch (error) {
		return { error: (error as Error).message };
	}
}

export function hasAllowRule(rules: readonly string[], sub: string): boolean {
	return (
		rules.includes(allowRuleFor(sub)) ||
		rules.includes(`Bash(${CLI_PATH}:*)`) ||
		rules.includes("Bash") ||
		rules.includes("Bash(*)")
	);
}

export interface PluginInstall {
	version: string;
	skillsDir: string;
}

export function installedPlugins(home: string): PluginInstall[] {
	return claudePluginSkillsDirs(home)
		.map((skillsDir) => ({
			skillsDir,
			version:
				dirname(dirname(dirname(skillsDir)))
					.split(/[\\/]/)
					.pop() ?? "",
		}))
		.sort((a, b) => compareVersions(b.version, a.version));
}

export function unslopInstalled(home: string): boolean {
	const cache = join(home, ".claude", "plugins", "cache");
	if (existsSync(join(home, ".claude", "skills", "unslop", "SKILL.md")))
		return true;
	try {
		return (
			[...new Bun.Glob("*/unslop").scanSync({ cwd: cache, onlyFiles: false })]
				.length > 0
		);
	} catch {
		return false;
	}
}
