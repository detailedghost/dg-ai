import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { die } from "../spec/shared";

export const ADR_DIR = "docs/adr";
export const DECISION_DIR = ".agents/decisions";
export const TOC_FILE = `${ADR_DIR}/toc.md`;
export const README_FILE = `${DECISION_DIR}/README.md`;
export const NOT_INITIALIZED = "not initialized. Run dg-skills adr init first.";

const RECORD_FILE = /^(\d{4})-.+\.md$/;

export function repoRoot(): string {
	const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "ignore" });
	const top = result.exitCode === 0 ? result.stdout.toString().trim() : "";
	return top === "" ? process.cwd() : top;
}

export function requireInitialized(root: string): void {
	if (!existsSync(join(root, README_FILE))) die(NOT_INITIALIZED);
}

export function refuseSymlink(path: string): void {
	if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) die(`${path} is a symbolic link. Refusing to write through it.`);
}

export function recordFiles(root: string, dir: string): string[] {
	const path = join(root, dir);
	if (!existsSync(path)) return [];
	return readdirSync(path)
		.filter((name) => RECORD_FILE.test(name))
		.sort();
}

export function nextNumber(root: string): string {
	const numbers = [ADR_DIR, DECISION_DIR].flatMap((dir) =>
		recordFiles(root, dir).map((name) => Number(name.slice(0, 4))),
	);
	return String(Math.max(0, ...numbers) + 1).padStart(4, "0");
}
