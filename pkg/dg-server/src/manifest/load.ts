import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import {
	CHAT_MAX_MANIFEST_BYTES,
	type CommandEntry,
	validateCommandManifest,
	validateProtoIdentifier,
} from "@dg/common";

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
			`cannot read command manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
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
			`invalid JSON in command manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		return validateCommandManifest(parsed, `command manifest ${path}`);
	} catch (error) {
		throw new ManifestLoadError(
			error instanceof Error ? error.message : String(error),
		);
	}
}

/** A subagent manifest is a plain list of names, each validated with the shared identifier grammar. */
export function loadSubagentManifestFile(path: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new ManifestLoadError(
			`cannot read subagent manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ManifestLoadError(
			`invalid JSON in subagent manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!Array.isArray(parsed)) {
		throw new ManifestLoadError(`subagent manifest ${path} must be an array`);
	}
	return parsed.map((name, index) => {
		try {
			return validateProtoIdentifier(name, `subagent manifest[${index}]`);
		} catch (error) {
			throw new ManifestLoadError(
				error instanceof Error ? error.message : String(error),
			);
		}
	});
}

/**
 * A literal denylist can't match a version-suffixed basename directly
 * (`python3.14`), so strip a trailing dot-version segment and then a
 * trailing bare digit run before comparing — matching "python3.14" only
 * after both strips reduce it to "python".
 */
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

export function resolveManifestForPublish(
	entries: CommandEntry[],
): CommandEntry[] {
	for (const [index, entry] of entries.entries()) {
		const executable = entry.argv[0];
		if (!executable) {
			throw new ManifestLoadError(
				`command manifest[${index}] (${entry.label}) has no executable in argv[0]`,
			);
		}
		const resolved = Bun.which(executable);
		if (!resolved) {
			throw new ManifestLoadError(
				`command manifest[${index}] (${entry.label}) executable "${executable}" does not resolve on PATH`,
			);
		}
		// Bun.which doesn't follow symlinks, so check both the un-realpath'd
		// name and the symlink-resolved one — either can dodge the denylist alone.
		const linkName = basename(resolved);
		let realName = linkName;
		try {
			realName = basename(realpathSync(resolved));
		} catch {
			// Bun.which already proved the executable path; the link name alone still gets checked.
		}
		if (isForbiddenExecutable(linkName) || isForbiddenExecutable(realName)) {
			const forbidden = isForbiddenExecutable(linkName) ? linkName : realName;
			throw new ManifestLoadError(
				`command manifest[${index}] (${entry.label}) resolves "${executable}" to forbidden shell or script host "${forbidden}"`,
			);
		}
	}
	return entries;
}
