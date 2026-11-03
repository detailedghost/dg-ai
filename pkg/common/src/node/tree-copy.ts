import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function rebaseLink(target: string, from: string, to: string): string {
	if (!isAbsolute(target)) return target;
	if (target === from) return to;
	return target.startsWith(`${from}${sep}`) ? join(to, relative(from, target)) : target;
}

/** Copies a file, folder or link to a new path with its modes; an absolute link into `from` is rebased into `to`. */
export function copyTree(from: string, to: string): void {
	const walk = (source: string, dest: string): void => {
		const stat = lstatSync(source);
		if (stat.isSymbolicLink()) {
			const target = rebaseLink(readlinkSync(source), from, to);
			if (process.platform === "win32" && statSync(source, { throwIfNoEntry: false })?.isDirectory())
				symlinkSync(resolve(dirname(dest), target), dest, "junction");
			else symlinkSync(target, dest);
			return;
		}
		if (stat.isDirectory()) {
			mkdirSync(dest, { mode: stat.mode & 0o777 });
			for (const name of readdirSync(source)) walk(join(source, name), join(dest, name));
			chmodSync(dest, stat.mode & 0o777);
			return;
		}
		copyFileSync(source, dest);
		chmodSync(dest, stat.mode & 0o777);
	};
	walk(from, to);
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
		} else out.set(key, `file:${stat.size}`);
	};
	walk(root);
	return out;
}

/** True when `to` holds the same entries, file sizes and link targets as `from`, after `copyTree` rebasing. */
export function treeMatches(from: string, to: string): boolean {
	const source = shape(from, (target) => rebaseLink(target, from, to));
	const copy = shape(to, (target) => target);
	if (source.size !== copy.size) return false;
	for (const [key, value] of source) if (copy.get(key) !== value) return false;
	return true;
}
