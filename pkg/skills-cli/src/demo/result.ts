import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import { isAlive, readCmdline } from "../pw/core/registry";
import { demosDir, legacyDemosDir } from "./paths";

export type DemoResult = {
	slug: string;
	outcome: "done" | "stopped" | "error";
	mode: "video";
	steps: number;
	video?: string;
	encoded: boolean;
	audio: "muxed" | "sidecar" | "none";
	startOffsetMs?: number;
	plan: string;
	startedAt: string;
	endedAt: string;
	error?: string;
};

const SAFE_SLUG = /^[\w][\w.-]*$/;

const resultFile = (slug: string): string => `${slug}.result.json`;

const slugDirs = (slug: string): string[] => [
	join(demosDir(), slug),
	join(legacyDemosDir(), slug),
];

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

export function readResult(slug: string): DemoResult | undefined {
	if (!SAFE_SLUG.test(slug)) return undefined;
	for (const dir of slugDirs(slug)) {
		const found = readJson(join(dir, resultFile(slug)));
		if (found) return found as DemoResult;
	}
	return undefined;
}

export function writeResult(
	result: DemoResult,
	dir = join(demosDir(), result.slug),
): void {
	ensurePrivateDir(dir);
	writeFileAtomic(
		join(dir, resultFile(result.slug)),
		JSON.stringify(result),
		0o600,
	);
}

const isPlayerOf = (slug: string, cmdline: string[]): boolean => {
	const at = cmdline.indexOf("__player");
	if (at < 0) return false;
	try {
		const job = JSON.parse(cmdline[at + 1] ?? "") as { slug?: unknown };
		return job.slug === slug;
	} catch {
		return false;
	}
};

/** A recycled pid that now runs some other program does not count as the player. */
export function playerPid(slug: string): number | undefined {
	for (const dir of slugDirs(slug)) {
		const file = join(dir, "player.pid");
		if (!existsSync(file)) continue;
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		if (!Number.isInteger(pid) || !isAlive(pid)) continue;
		const cmdline = readCmdline(pid);
		if (!cmdline || isPlayerOf(slug, cmdline)) return pid;
	}
	return undefined;
}

export function statusLine(slug: string): string {
	if (!SAFE_SLUG.test(slug)) return `no run for ${slug}`;
	const result = readResult(slug);
	if (result) return JSON.stringify(result);
	const pid = playerPid(slug);
	return pid === undefined ? `no run for ${slug}` : `running (pid ${pid})`;
}
