import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { slugify } from "@dg/common";
import {
	isWSL as detectWSL,
	run as runCommand,
	windowsUserProfile,
} from "./lib";

type SystemSeams = {
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: Record<string, string | undefined>;
	isWSL?: () => boolean;
	run?: (command: string, args: string[]) => string;
	windowsUserProfile?: () => string;
};

/** Resolve the browser's Downloads directory for the current platform. */
export function resolveDownloadsDir(seams: SystemSeams = {}): string {
	const platform = seams.platform ?? process.platform;
	const homeDir = seams.homeDir ?? homedir();
	const isWSL = seams.isWSL ?? detectWSL;
	const run = seams.run ?? runCommand;

	if (platform === "linux" && isWSL()) {
		// Supported WSL openers launch the Windows-side default browser, so its
		// downloads land in the Windows profile rather than Linux ~/Downloads.
		const profile =
			seams.windowsUserProfile?.() ??
			(seams.run
				? run("cmd.exe", ["/c", "echo", "%USERPROFILE%"]).replace(/\r/g, "")
				: windowsUserProfile());
		return run("wslpath", ["-u", `${profile}\\Downloads`]);
	}

	if (platform === "win32") return `${homeDir}\\Downloads`;
	if (platform === "linux") {
		try {
			const configured = run("xdg-user-dir", ["DOWNLOAD"]).trim();
			if (configured) return configured;
		} catch {
			// xdg-user-dir is optional; the conventional fallback is stable.
		}
	}
	return join(homeDir, "Downloads");
}

/** Stable collision-resistant slug derived from a URL's host/path and full URL. */
export function protoSlug(url: string): string {
	const parsed = new URL(url);
	const stem =
		slugify(`${parsed.hostname}${parsed.pathname}`, "prototype")
			.replace(/^[^a-z0-9]+/, "")
			.slice(0, 119) || "prototype";
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
	return `${stem}-${hash}`;
}

/** Browser download-relative path. Always uses URL/download path separators. */
export function dgProtoPath(slug: string, file: string): string {
	return posix.join("dg-proto", slug, file);
}

/**
 * Durable prototype answer path, resolved from the invoking project's cwd.
 *
 * Unlike browser downloads and agent scratch, callers must run answer-writing
 * commands from the target project root.
 */
export function answerPagePath(slug: string, file: string): string {
	return resolve(process.cwd(), ".agents", "prototype", slug, file);
}

/** Stable agent output path; never points into Downloads or repository state. */
export function protoScratchPath(
	slug: string,
	file: string,
	seams: Pick<SystemSeams, "env" | "homeDir"> = {},
): string {
	const env = seams.env ?? process.env;
	const homeDir = seams.homeDir ?? homedir();
	const root = env.AI_SCRATCH_DIR
		? join(env.AI_SCRATCH_DIR, "proto")
		: join(homeDir, ".dg", "proto");
	return join(root, slug, file);
}

/** Timing controls for polling a browser-created JSON download. */
export type PollForFileOptions = {
	timeoutMs: number;
	intervalMs?: number;
};

const TIMEOUT_HELP =
	"Check for a relocated Downloads dir, disable 'ask where to save each file', and on WSL ensure the default browser is Windows-side rather than a Linux-side browser.";

/**
 * Poll for a completed JSON download. Chrome partials and transient malformed
 * writes are retried until the timeout rather than treated as final failures.
 */
export async function pollForFile<T = unknown>(
	path: string,
	options: PollForFileOptions,
): Promise<T> {
	const intervalMs = options.intervalMs ?? 200;
	const deadline = Date.now() + options.timeoutMs;

	while (Date.now() <= deadline) {
		try {
			await access(`${path}.crdownload`);
		} catch {
			try {
				return JSON.parse(await readFile(path, "utf8")) as T;
			} catch {
				// File absent, still being flushed, or transiently malformed.
			}
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, remaining)),
		);
	}

	throw new Error(`Timed out waiting for ${path}. ${TIMEOUT_HELP}`);
}
