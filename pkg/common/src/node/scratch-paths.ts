import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";

/** Per-cwd bucket for working artifacts, including separate linked worktrees. */
export function cwdHash(dir: string = process.cwd()): string {
	return createHash("sha1").update(dir).digest("hex").slice(0, 8);
}

export function projectRoot(dir: string = process.cwd()): string {
	try {
		const result = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: dir, stderr: "ignore" });
		if (result.exitCode === 0) {
			const first = result.stdout
				.toString()
				.split("\n")
				.find((l) => l.startsWith("worktree "));
			if (first) return first.slice("worktree ".length).trim();
		}
	} catch {
		// Outside git, retain the supplied cwd.
	}
	return dir;
}

/** Stable project bucket for handoff state shared by linked worktrees. */
export function projectHash(dir: string = process.cwd()): string {
	return createHash("sha1").update(projectRoot(dir)).digest("hex").slice(0, 8);
}

export function randSuffix(len = 4): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	const bytes = crypto.getRandomValues(new Uint8Array(len * 2));
	for (const b of bytes) {
		if (out.length >= len) break;
		const idx = b % chars.length;
		out += chars[idx];
	}
	return out;
}

export function readableSuffix(): string {
	return uniqueNamesGenerator({ dictionaries: [adjectives, animals], separator: "-", length: 2 });
}

export function repoRoot(dir: string = process.cwd()): string | null {
	const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stderr: "ignore" });
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().trim() || null;
}

export function findAgentsDir(startDir?: string): string | null {
	let d = path.resolve(startDir ?? process.cwd());
	while (true) {
		const candidate = path.join(d, ".agents");
		const stat = (() => {
			try {
				return statSync(candidate);
			} catch {
				return null;
			}
		})();
		if (stat?.isDirectory()) return candidate;
		const parent = path.dirname(d);
		if (parent === d) return null; // reached filesystem root
		d = parent;
	}
}

export function isPathInside(child: string, parent: string): boolean {
	const c = path.resolve(child);
	const p = path.resolve(parent);
	return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export interface ScratchPathOptions {
	/** Accepted for compatibility; no longer enforced. */
	ephemeral?: boolean;
	cwdScope?: boolean;
	cwd?: string;
}

const PRIVATE_DIR_MODE = 0o700;

export function scratchRoot(): string {
	// Ephemeral root for every AI tool + worktree; override with AI_SCRATCH_DIR.
	return process.env["AI_SCRATCH_DIR"] ?? "/tmp/ai";
}

export function stateRoot(): string {
	const explicit = process.env["AI_STATE_DIR"];
	if (explicit) return explicit;
	const xdg = process.env["XDG_STATE_HOME"];
	return path.join(xdg || path.join(homedir(), ".local", "state"), "ai");
}

function rootedDir(base: string, bucket: string, tool: string, opts: ScratchPathOptions): string {
	const dir = opts.cwdScope === false ? path.join(base, tool) : path.join(base, tool, bucket);
	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	return dir;
}

function rootedPath(base: string, bucket: string, tool: string, name?: string, opts: ScratchPathOptions = {}): string {
	const dir = rootedDir(base, bucket, tool, opts);

	if (name) {
		if (path.isAbsolute(name) || name.includes("..")) {
			throw new Error(`scratchPath: name must be a plain filename, got: ${name}`);
		}
		return path.join(dir, name);
	}

	return path.join(dir, uniqueName(tool));
}

export function uniqueName(tool: string, suffix = ""): string {
	const iso = new Date().toISOString();
	const ymd = iso.slice(0, 10).replace(/-/g, "");
	const hm = iso.slice(11, 16).replace(":", "");
	return `${tool}-${ymd}-${hm}-${randSuffix()}${suffix}`;
}

function resolveCwd(opts: ScratchPathOptions): string | undefined {
	return opts.cwd ? path.resolve(opts.cwd) : undefined;
}

export function scratchDir(tool: string, opts: ScratchPathOptions = {}): string {
	return rootedDir(scratchRoot(), cwdHash(resolveCwd(opts)), tool, opts);
}

export function stateDir(tool: string, opts: ScratchPathOptions = {}): string {
	return rootedDir(stateRoot(), projectHash(resolveCwd(opts)), tool, opts);
}

export function scratchPath(tool: string, name?: string, opts: ScratchPathOptions = {}): string {
	return rootedPath(scratchRoot(), cwdHash(resolveCwd(opts)), tool, name, opts);
}

export function statePath(tool: string, name?: string, opts: ScratchPathOptions = {}): string {
	return rootedPath(stateRoot(), projectHash(resolveCwd(opts)), tool, name, opts);
}

export class NotInWorktreeError extends Error {
	constructor() {
		super("not in a git worktree");
	}
}

export function agentsRoot(opts: { cwd?: string; main?: boolean } = {}): string {
	const dir = path.resolve(opts.cwd ?? process.cwd());
	const top = repoRoot(dir);
	if (!top) throw new NotInWorktreeError();
	return path.join(opts.main ? projectRoot(dir) : top, ".agents");
}

export function agentsPath(tool: string, name?: string, opts: { cwd?: string; main?: boolean } = {}): string {
	const dir = path.join(agentsRoot(opts), tool);
	if (!name) {
		mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
		return dir;
	}
	const full = path.join(dir, name);
	mkdirSync(path.dirname(full), { recursive: true, mode: PRIVATE_DIR_MODE });
	return full;
}
