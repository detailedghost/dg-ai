import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isRecord } from "@dg/common";
import { writeFileAtomic } from "@dg/common/node";

export const PROGRAM = "dg-skills spec";

/** A failure the dispatcher reports as `dg-skills spec: <message>` with its own exit status. */
export class SpecError extends Error {
	constructor(
		message: string,
		readonly status: number = 2,
	) {
		super(message);
		this.name = "SpecError";
	}
}

export type Handler = (args: string[]) => Promise<number> | number;

export function die(message: string): never {
	throw new SpecError(message, 2);
}

export function deny(message: string): never {
	throw new SpecError(message, 1);
}

export function usageError(syntax: string): never {
	return die(`usage: ${PROGRAM} ${syntax}`);
}

export function say(text: string): void {
	process.stdout.write(text);
}

export function warn(message: string): void {
	process.stderr.write(`${PROGRAM}: ${message}\n`);
}

/** jq truthiness: everything except null and false. */
export function truthy(value: unknown): boolean {
	return value !== undefined && value !== null && value !== false;
}

/** jq `length` for the shapes frontmatter can hold. */
export function jqLength(value: unknown): number {
	if (Array.isArray(value) || typeof value === "string") return value.length;
	if (isRecord(value)) return Object.keys(value).length;
	return 0;
}

/** jq `-r`: strings raw, everything else as JSON. */
export function jqRaw(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "null";
	return typeof value === "object" && value !== null
		? JSON.stringify(value, null, 2)
		: JSON.stringify(value);
}

/** jq `tostring` and string interpolation. */
export function jqText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value ?? null);
}

/** Drop trailing newlines the way shell command substitution does. */
export function stripNewlines(text: string): string {
	return text.replace(/\n+$/, "");
}

/** Split text into awk records: no phantom record after a final newline. */
export function records(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function joinRecords(lines: string[]): string {
	return lines.map((line) => `${line}\n`).join("");
}

export function needFile(path: string): void {
	const stat = statSync(path, { throwIfNoEntry: false });
	if (!stat?.isFile()) die(`file not found: ${path}`);
	try {
		accessSync(path, constants.R_OK);
	} catch {
		die(`file not readable: ${path}`);
	}
}

export function isDirectory(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

export function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Absolute path without normalizing, matching the legacy tool's output. */
export function abspath(path: string): string {
	return isAbsolute(path) ? path : `${process.cwd()}/${path}`;
}

export function flagValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (value === undefined) die(`${flag} requires a value`);
	return value;
}

export async function readText(path: string): Promise<string> {
	return Bun.file(path).text();
}

/** Replace an existing file through a sibling temp file, keeping its mode. */
export function replaceText(path: string, text: string): void {
	writeFileAtomic(path, text, statSync(path).mode & 0o7777);
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function localDate(now: Date = new Date()): string {
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function localStamp(now: Date = new Date()): string {
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `${localDate(now).replaceAll("-", "")}-${time}`;
}

export function utcMinute(now: Date = new Date()): string {
	return `${now.toISOString().slice(0, 16)}Z`;
}

/** Read one newline-terminated line from stdin; null when input ends first. */
export async function readStdinLine(): Promise<string | null> {
	const reader = Bun.stdin.stream().getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return null;
			buffer += decoder.decode(value, { stream: true });
			const newline = buffer.indexOf("\n");
			if (newline >= 0) return buffer.slice(0, newline);
		}
	} finally {
		reader.releaseLock();
	}
}

const NUMERIC = /^[ \t\n]*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[ \t\n]*$/;
const NUMERIC_PREFIX = /^[ \t\n]*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/;

/** awk `text + 0`: the leading numeric prefix, else zero. */
export function awkNumber(text: string): number {
	const match = NUMERIC_PREFIX.exec(text);
	return match ? Number(match[0]) : 0;
}

/** awk `==` on two input strings: numeric when both look numeric. */
export function awkEquals(left: string, right: string): boolean {
	return NUMERIC.test(left) && NUMERIC.test(right)
		? Number(left) === Number(right)
		: left === right;
}

/** awk `split`: an empty string yields no fields. */
export function awkSplit(text: string, separator: string): string[] {
	return text === "" ? [] : text.split(separator);
}
