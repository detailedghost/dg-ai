import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import {
	CHAT_MAX_MANIFEST_BYTES,
	type CommandEntry,
	validateCommandManifest,
} from "../chat-format";
import { describeError } from "../errors";
import { validateProtoIdentifier } from "../proto-format";

const FORBIDDEN_EXECUTABLES = new Set([
	"sh",
	"bash",
	"dash",
	"zsh",
	"ksh",
	"csh",
	"tcsh",
	"fish",
	"cmd",
	"cmd.exe",
	"powershell",
	"powershell.exe",
	"pwsh",
	"pwsh.exe",
	"env",
	"osascript",
	"node",
	"bun",
	"python",
	"python3",
	"perl",
	"ruby",
	"php",
	"lua",
	"luajit",
	"deno",
	"tclsh",
	"wish",
	"expect",
	"awk",
	"gawk",
	"busybox",
	"xargs",
	"find",
	"nohup",
	"setsid",
	"script",
	"ssh",
	"nc",
	"ncat",
	"socat",
]);

export class ManifestLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestLoadError";
	}
}

export function loadManifestFile(path: string): CommandEntry[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new ManifestLoadError(
			`cannot read command manifest ${path}: ${describeError(error)}`,
		);
	}
	if (Buffer.byteLength(raw, "utf8") > CHAT_MAX_MANIFEST_BYTES) {
		throw new ManifestLoadError(
			`command manifest ${path} exceeds CHAT_MAX_MANIFEST_BYTES (${CHAT_MAX_MANIFEST_BYTES})`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ManifestLoadError(
			`invalid JSON in command manifest ${path}: ${describeError(error)}`,
		);
	}
	try {
		return validateCommandManifest(parsed, `command manifest ${path}`);
	} catch (error) {
		throw new ManifestLoadError(describeError(error));
	}
}

export function loadSubagentManifestFile(path: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new ManifestLoadError(
			`cannot read subagent manifest ${path}: ${describeError(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ManifestLoadError(
			`invalid JSON in subagent manifest ${path}: ${describeError(error)}`,
		);
	}
	if (!Array.isArray(parsed)) {
		throw new ManifestLoadError(`subagent manifest ${path} must be an array`);
	}
	return parsed.map((name, index) => {
		try {
			return validateProtoIdentifier(name, `subagent manifest[${index}]`);
		} catch (error) {
			throw new ManifestLoadError(describeError(error));
		}
	});
}

function normalizeExecutableBasename(name: string): string {
	let normalized = name.toLowerCase();
	while (/\.\d+$/.test(normalized)) {
		normalized = normalized.replace(/\.\d+$/, "");
	}
	return normalized.replace(/\d+$/, "");
}

function isForbiddenExecutable(rawBasename: string): boolean {
	return FORBIDDEN_EXECUTABLES.has(normalizeExecutableBasename(rawBasename));
}

export function checkExecutable(
	executable: string | undefined,
): string | undefined {
	if (!executable) return "has no executable in argv[0]";
	const resolved = Bun.which(executable);
	if (!resolved) {
		return `executable "${executable}" does not resolve on PATH`;
	}
	const linkName = basename(resolved);
	let realName = linkName;
	try {
		realName = basename(realpathSync(resolved));
	} catch {}
	if (isForbiddenExecutable(linkName) || isForbiddenExecutable(realName)) {
		const forbidden = isForbiddenExecutable(linkName) ? linkName : realName;
		return `resolves "${executable}" to forbidden shell or script host "${forbidden}"`;
	}
	return undefined;
}

export function resolveManifestForPublish(
	entries: CommandEntry[],
): CommandEntry[] {
	for (const [index, entry] of entries.entries()) {
		const reason = checkExecutable(entry.argv[0]);
		if (reason) {
			throw new ManifestLoadError(
				`command manifest[${index}] (${entry.label}) ${reason}`,
			);
		}
	}
	return entries;
}
