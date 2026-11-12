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
	statSync,
	symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
