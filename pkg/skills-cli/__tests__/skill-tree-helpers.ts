import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_SKILLS, splitFrontmatter } from "./spec-fixtures";

export const FLAG = /(?<![\w-])(--[a-z][a-z-]*|-[A-Za-z])(?![\w-])/g;
export const SHELL_LANGS = ["sh", "bash", "zsh", "shell", "powershell", ""];

export interface Fence {
	lang: string;
	body: string;
}

export function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.sort()
		.flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? walk(path) : [path];
		});
}

export function skillDir(name: string): string {
	return join(SOURCE_SKILLS, name);
}

export function skillText(name: string): string {
	return readFileSync(join(skillDir(name), "SKILL.md"), "utf8");
}

export function treeFiles(name: string): { file: string; text: string }[] {
	const root = skillDir(name);
	return walk(root).map((path) => ({
		file: path.slice(root.length + 1),
		text: readFileSync(path, "utf8"),
	}));
}

export function treeText(name: string): string {
	return treeFiles(name)
		.map(({ text }) => text)
		.join("\n");
}

export function fences(text: string): Fence[] {
	return [...text.matchAll(/```([\w-]*)\n([\s\S]*?)```/g)].map((match) => ({
		lang: match[1] ?? "",
		body: match[2] ?? "",
	}));
}

export function hasShellComment(line: string): boolean {
	const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
	return /(^|\s)#(?!!)/.test(bare);
}

export function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

export function flagsTable(text: string) {
	const lines = text.split("\n");
	const start = lines.indexOf("## Flags");
	if (start === -1) return null;
	const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
	const rows = lines
		.slice(start + 1, end === -1 ? undefined : end)
		.filter((line) => line.startsWith("|"));
	const documented = new Set(
		rows.slice(2).flatMap((row) =>
			cells(row)
				.slice(0, 2)
				.flatMap((cell) => [...cell.matchAll(FLAG)].map((match) => match[1])),
		),
	);
	return { header: cells(rows[0] ?? ""), documented };
}

export function usageLine(text: string): string {
	return text.split("\n").find((line) => line.startsWith("**Usage:**")) ?? "";
}

export function codeSpans(text: string): string[] {
	const inFences = fences(text).flatMap(({ body }) => body.split("\n"));
	const inline = [
		...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g),
	].map((match) => match[1] ?? "");
	return [...inFences, ...inline].map((span) =>
		span.trim().replace(/^\$ /, ""),
	);
}

export function bareSlash(skill: string): RegExp {
	return new RegExp(`(?<![\\w./~:$<>-])/${skill}(?![\\w:/-])`);
}

export function expectNoShellComments(name: string): void {
	for (const { file, text } of treeFiles(name))
		for (const { lang, body } of fences(text))
			if (SHELL_LANGS.includes(lang))
				for (const line of body.split("\n"))
					expect([file, line, hasShellComment(line)]).toEqual([
						file,
						line,
						false,
					]);
}

export function expectNamespacedSlashOnly(name: string): void {
	const text = skillText(name);
	expect(text).toContain(`/dg:${name}`);
	expect(text).not.toMatch(bareSlash(name));
}

export function expectPlainFrontmatter(name: string): void {
	const { data } = splitFrontmatter(skillText(name)) as {
		data: Record<string, unknown>;
	};
	expect(data.name).toBe(name);
	expect(String(data.description).length).toBeGreaterThan(0);
	expect(data).not.toHaveProperty("argument-hint");
	expect(data).not.toHaveProperty("user-invocable");
}

export function firstCallIndex(text: string): { gate: number; call: number } {
	const lines = text.split("\n");
	return {
		gate: lines.findIndex((line) => line.includes("bootstrap.sh")),
		call: lines.findIndex(
			(line) =>
				line.includes("dg-skills") &&
				!line.includes("--help") &&
				!line.includes("bootstrap.sh"),
		),
	};
}
