import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	adjectives,
	animals,
	uniqueNamesGenerator,
} from "unique-names-generator";

/** Per-cwd bucket for working artifacts, including separate linked worktrees. */
export function cwdHash(dir: string = process.cwd()): string {
	return createHash("sha1").update(dir).digest("hex").slice(0, 8);
}

/** Return the main worktree path, falling back to the supplied directory when Git cannot resolve it. */
export function projectRoot(dir: string = process.cwd()): string {
	try {
		const result = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
			cwd: dir,
			stderr: "ignore",
		});
		if (result.exitCode === 0) {
			const first = result.stdout
				.toString()
				.split("\n")
				.find((l) => l.startsWith("worktree "));
			if (first) return first.slice("worktree ".length).trim();
		}
	} catch {
		return dir;
	}
	return dir;
}

/** Stable project bucket for handoff state shared by linked worktrees. */
export function projectHash(dir: string = process.cwd()): string {
	return createHash("sha1").update(projectRoot(dir)).digest("hex").slice(0, 8);
}

/** Generate a lowercase alphanumeric suffix from random bytes; this is a filename suffix, not a secret. */
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

/** Generate an adjective-animal name such as `brave-otter` for human-readable filenames. */
export function readableSuffix(): string {
	return uniqueNamesGenerator({
		dictionaries: [adjectives, animals],
		separator: "-",
		length: 2,
	});
}

/** Return the current worktree toplevel, or null when Git reports no checkout. */
export function repoRoot(dir: string = process.cwd()): string | null {
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
			cwd: dir,
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return null;
		return result.stdout.toString().trim() || null;
	} catch {
		return null;
	}
}

/** Find the nearest ancestor containing an .agents directory; return null at the filesystem root. */
export function findAgentsDir(startDir?: string): string | null {
	let d = path.resolve(startDir ?? process.cwd());
	while (true) {
		const candidate = path.join(d, ".agents");
		const stat = statSync(candidate, { throwIfNoEntry: false });
		if (stat?.isDirectory()) return candidate;
		const parent = path.dirname(d);
		if (parent === d) return null;
		d = parent;
	}
}

/** Check lexical containment after resolving both paths; this does not resolve symlinks. */
export function isPathInside(child: string, parent: string): boolean {
	const c = path.resolve(child);
	const p = path.resolve(parent);
	return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Select the working directory and bucket scope; disabling cwdScope shares the tool directory. */
export interface ScratchPathOptions {
	cwdScope?: boolean;
	cwd?: string;
}

const PRIVATE_DIR_MODE = 0o700;

/** Resolve the configured scratch root without creating or validating it. */
export function scratchRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env["AI_SCRATCH_DIR"] || "/tmp/ai";
}

/** Resolve AI_STATE_DIR, else the XDG state root under ai, without touching the filesystem. */
export function stateRoot(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const explicit = env["AI_STATE_DIR"];
	if (explicit) return explicit;
	const xdg = env["XDG_STATE_HOME"];
	return path.join(xdg || path.join(home, ".local", "state"), "ai");
}

function directoryEntry(dir: string) {
	try {
		return lstatSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
		} catch (mkdirError) {
			if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
				throw mkdirError;
		}
		return lstatSync(dir);
	}
}

function unsafeDirectory(dir: string): never {
	throw new Error(`unsafe scratch/state directory: ${dir}`);
}

function safeAncestors(
	dir: string,
	uid: number | undefined,
	systemUid: number,
): void {
	const parent = path.dirname(dir);
	if (parent !== dir) safeAncestors(parent, uid, systemUid);
	const entry = directoryEntry(dir);
	if (
		uid !== undefined &&
		entry.uid !== uid &&
		entry.uid !== 0 &&
		entry.uid !== systemUid
	)
		unsafeDirectory(dir);
	if (entry.isSymbolicLink()) {
		safeAncestors(realpathSync(dir), uid, systemUid);
		return;
	}
	if (!entry.isDirectory()) unsafeDirectory(dir);
	if (
		uid !== undefined &&
		(entry.mode & 0o022) !== 0 &&
		(entry.mode & 0o1000) === 0
	)
		unsafeDirectory(dir);
}

/** Throw when a managed root, or any ancestor, is a non-directory, a foreign or group/world-writable dir, or a disallowed link. */
export function assertSafeRoot(base: string, allowRootLink: boolean): void {
	const root = path.resolve(base);
	const uid = process.getuid?.();
	const systemUid = lstatSync(path.parse(root).root).uid;
	safeAncestors(path.dirname(root), uid, systemUid);
	const entry = directoryEntry(root);
	if (entry.isSymbolicLink()) {
		if (!allowRootLink || (uid !== undefined && entry.uid !== uid))
			unsafeDirectory(root);
		safeAncestors(realpathSync(root), uid, systemUid);
	}
	const rootStat = statSync(root);
	if (
		!rootStat.isDirectory() ||
		(uid !== undefined &&
			(rootStat.uid !== uid || (rootStat.mode & 0o022) !== 0))
	)
		unsafeDirectory(root);
}

function rootedDir(
	base: string,
	bucket: string,
	tool: string,
	opts: ScratchPathOptions,
	allowRootLink: boolean,
): string {
	const dir =
		opts.cwdScope === false
			? path.join(base, tool)
			: path.join(base, tool, bucket);
	const root = path.resolve(base);
	const relative = path.relative(root, path.resolve(dir));
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		unsafeDirectory(dir);
	const uid = process.getuid?.();
	assertSafeRoot(root, allowRootLink);
	let child = root;
	for (const segment of relative.split(path.sep)) {
		child = path.join(child, segment);
		const childStat = directoryEntry(child);
		if (
			!childStat.isDirectory() ||
			childStat.isSymbolicLink() ||
			(uid !== undefined &&
				(childStat.uid !== uid || (childStat.mode & 0o022) !== 0))
		)
			unsafeDirectory(child);
		if (uid !== undefined && (childStat.mode & 0o777) !== PRIVATE_DIR_MODE)
			chmodSync(child, PRIVATE_DIR_MODE);
	}
	return dir;
}

function rootedPath(
	base: string,
	bucket: string,
	tool: string,
	name: string | undefined,
	opts: ScratchPathOptions,
	allowRootLink: boolean,
): string {
	const dir = rootedDir(base, bucket, tool, opts, allowRootLink);

	if (name) {
		if (name === "." || name === ".." || path.basename(name) !== name) {
			throw new Error(
				`scratchPath: name must be a plain filename, got: ${name}`,
			);
		}
		return path.join(dir, name);
	}

	return path.join(dir, uniqueName(tool));
}

/** Build a UTC date/minute artifact name with a random suffix and the caller-supplied suffix. */
export function uniqueName(tool: string, suffix = ""): string {
	const iso = new Date().toISOString();
	const ymd = iso.slice(0, 10).replace(/-/g, "");
	const hm = iso.slice(11, 16).replace(":", "");
	return `${tool}-${ymd}-${hm}-${randSuffix()}${suffix}`;
}

function resolveCwd(opts: ScratchPathOptions): string | undefined {
	return opts.cwd ? path.resolve(opts.cwd) : undefined;
}

/** Create a private cwd-scoped tool directory; reject unsafe ownership, permissions, or managed symlinks. */
export function scratchDir(
	tool: string,
	opts: ScratchPathOptions = {},
): string {
	return rootedDir(
		scratchRoot(),
		cwdHash(resolveCwd(opts)),
		tool,
		opts,
		!!process.env["AI_SCRATCH_DIR"],
	);
}

/** Create a private project-scoped tool directory shared by linked worktrees; reject unsafe managed paths. */
export function stateDir(tool: string, opts: ScratchPathOptions = {}): string {
	return rootedDir(
		stateRoot(),
		projectHash(resolveCwd(opts)),
		tool,
		opts,
		!!process.env["AI_STATE_DIR"],
	);
}

/** Resolve a named or generated scratch path, creating its private directory but not the file. */
export function scratchPath(
	tool: string,
	name?: string,
	opts: ScratchPathOptions = {},
): string {
	return rootedPath(
		scratchRoot(),
		cwdHash(resolveCwd(opts)),
		tool,
		name,
		opts,
		!!process.env["AI_SCRATCH_DIR"],
	);
}

/** Resolve a named or generated state path, creating its private project directory but not the file. */
export function statePath(
	tool: string,
	name?: string,
	opts: ScratchPathOptions = {},
): string {
	return rootedPath(
		stateRoot(),
		projectHash(resolveCwd(opts)),
		tool,
		name,
		opts,
		!!process.env["AI_STATE_DIR"],
	);
}

/** Signal that a repository-local artifact path was requested outside a Git worktree. */
export class NotInWorktreeError extends Error {
	constructor() {
		super("not in a git worktree");
	}
}

/** Resolve .agents in the current or main worktree; throw NotInWorktreeError outside Git. */
export function agentsRoot(
	opts: { cwd?: string; main?: boolean } = {},
): string {
	const dir = path.resolve(opts.cwd ?? process.cwd());
	const top = repoRoot(dir);
	if (!top) throw new NotInWorktreeError();
	return path.join(opts.main ? projectRoot(dir) : top, ".agents");
}

/** Resolve a repository artifact path and create its parent; an omitted name returns the tool directory. */
export function agentsPath(
	tool: string,
	name?: string,
	opts: { cwd?: string; main?: boolean } = {},
): string {
	const root = agentsRoot(opts);
	const dir = path.join(root, tool);
	const full = name ? path.join(dir, name) : dir;
	if (!isPathInside(dir, root) || !isPathInside(full, dir))
		throw new Error(
			`agentsPath: path must stay inside .agents, got: ${tool}/${name ?? ""}`,
		);
	if (!name) {
		mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
		return dir;
	}
	mkdirSync(path.dirname(full), { recursive: true, mode: PRIVATE_DIR_MODE });
	return full;
}
