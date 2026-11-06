import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	openSync,
	readSync,
	closeSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DETACHED_PREFIX } from "./layout";

function rebaseLink(target: string, from: string, to: string): string {
	if (!isAbsolute(target)) return target;
	if (target === from) return to;
	return target.startsWith(`${from}${sep}`) ? join(to, relative(from, target)) : target;
}

function linksToDirectory(link: string): boolean {
	try {
		return statSync(link).isDirectory();
	} catch {
		return false;
	}
}

/** Copies a file, folder or link to a new path with its modes; an absolute link into `from` is rebased into `to`. */
export function copyTree(from: string, to: string): void {
	const walk = (source: string, dest: string): void => {
		const stat = lstatSync(source);
		if (stat.isSymbolicLink()) {
			const target = rebaseLink(readlinkSync(source), from, to);
			if (process.platform === "win32" && linksToDirectory(source))
				symlinkSync(resolve(dirname(dest), target), dest, "junction");
			else symlinkSync(target, dest);
			return;
		}
		if (stat.isDirectory()) {
			mkdirSync(dest, { mode: (stat.mode & 0o777) | 0o700 });
			for (const name of readdirSync(source)) walk(join(source, name), join(dest, name));
			chmodSync(dest, stat.mode & 0o777);
			return;
		}
		copyFileSync(source, dest);
		chmodSync(dest, stat.mode & 0o777);
	};
	walk(from, to);
}

function fileHash(path: string): string {
	const hash = createHash("sha256");
	const buffer = Buffer.alloc(1 << 20);
	const fd = openSync(path, "r");
	try {
		for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

function shape(root: string, rebase: (target: string) => string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (current: string): void => {
		const stat = lstatSync(current);
		const key = relative(root, current);
		if (stat.isSymbolicLink()) out.set(key, `link:${rebase(resolve(dirname(current), readlinkSync(current)))}`);
		else if (stat.isDirectory()) {
			out.set(key, "dir");
			for (const name of readdirSync(current)) walk(join(current, name));
		} else out.set(key, `file:${fileHash(current)}`);
	};
	walk(root);
	return out;
}

/** True when `to` holds the same entries, file bytes and link targets as `from`, after `copyTree` rebasing. */
export function treeMatches(from: string, to: string): boolean {
	const source = shape(from, (target) => rebaseLink(target, from, to));
	const copy = shape(to, (target) => target);
	if (source.size !== copy.size) return false;
	for (const [key, value] of source) if (copy.get(key) !== value) return false;
	return true;
}

/** True when every folder and file in `from` is in `to` with the same bytes; links and extra entries in `to` are ignored. */
export function treeContained(from: string, to: string): boolean {
	const source = shape(from, (target) => target);
	const copy = shape(to, (target) => target);
	for (const [key, value] of source) {
		if (value.startsWith("link:")) continue;
		if (copy.get(key) !== value) return false;
	}
	return true;
}

export type MoveSeams = {
	log?: (line: string) => void;
	verify?: (copy: string) => string[];
	afterCopy?: (from: string, to: string) => void;
	rename?: (from: string, to: string) => void;
	removeTree?: (path: string) => void;
};

export type MoveResult = "moved" | "failed" | "kept" | "scheduled";

type Pair = { from: string; to: string };

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Deletes a folder and ignores a failure, so a leftover never stops a run. */
export function removeTree(path: string, seams: Pick<MoveSeams, "removeTree"> = {}): void {
	try {
		(seams.removeTree ?? ((target: string) => rmSync(target, { recursive: true, force: true })))(path);
	} catch {}
}

/** Detaches the source with one rename first, so a folder a running program holds open is never half deleted. */
export function removeSource(from: string, seams: Pick<MoveSeams, "rename" | "removeTree"> = {}): boolean {
	const detached = join(dirname(from), `${DETACHED_PREFIX}${basename(from)}-${process.pid}`);
	try {
		(seams.rename ?? renameSync)(from, detached);
	} catch {
		return false;
	}
	removeTree(detached, seams);
	return true;
}

const pairsOf = (from: string | readonly string[], to: string): Pair[] =>
	typeof from === "string"
		? [{ from, to }]
		: from.map((source) => ({ from: source, to: join(to, basename(source)) }));

function copyChecked(pair: Pair, seams: MoveSeams): string | undefined {
	try {
		mkdirSync(dirname(pair.to), { recursive: true, mode: 0o700 });
		copyTree(pair.from, pair.to);
		seams.afterCopy?.(pair.from, pair.to);
		if (!treeMatches(pair.from, pair.to)) throw new Error("the copy does not match the source");
		return undefined;
	} catch (err) {
		return `moving it to ${pair.to} failed: ${err instanceof Error ? err.message : err}`;
	}
}

function copyAllChecked(pairs: readonly Pair[], seams: MoveSeams): string | undefined {
	for (const pair of pairs) {
		const failure = copyChecked(pair, seams);
		if (failure) return failure;
	}
	const [problem] = pairs.flatMap((pair) => seams.verify?.(pair.to) ?? []);
	return problem === undefined ? undefined : `the copy failed its check: ${problem}`;
}

/** Copies `from` (or a list of files into the folder `to`) to `to`, checks every copy, then removes the sources; never writes over an existing `to`. */
export function moveVerified(from: string | readonly string[], to: string, seams: MoveSeams = {}): MoveResult {
	const log = seams.log ?? (() => {});
	const pairs = pairsOf(from, to);
	const taken = pairs.find((pair) => present(pair.to));
	if (taken) {
		log(`dg: kept ${taken.from}; ${taken.to} already exists`);
		return "kept";
	}
	const failure = copyAllChecked(pairs, seams);
	if (failure) {
		for (const pair of pairs) rmSync(pair.to, { recursive: true, force: true });
		log(`dg: kept ${pairs[0]?.from}; ${failure}`);
		return "failed";
	}
	if (pairs.map((pair) => removeSource(pair.from, seams)).every(Boolean)) return "moved";
	log(`dg: copied ${pairs[0]?.from} to ${pairs[0]?.to}; it is in use, so the next dg start removes it`);
	return "scheduled";
}

/** Renames an unused root to `<root>.empty-<ts>` and returns the new path. */
export function setAsideUnusedRoot(root: string, now: number): string {
	const aside = `${root}.empty-${now}`;
	renameSync(root, aside);
	return aside;
}
