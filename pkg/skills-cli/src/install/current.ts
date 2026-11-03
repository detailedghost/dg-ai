import { readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

export type CurrentKind = "lib" | "runtime";

const currentLink = (root: string, kind: CurrentKind): string => join(root, kind, "current");

/** The directory name `<root>/<kind>/current` points at, or undefined when the link is absent. */
export function readCurrent(root: string, kind: CurrentKind): string | undefined {
	try {
		return basename(readlinkSync(currentLink(root, kind)));
	} catch {
		return undefined;
	}
}

/** Points `<root>/<kind>/current` at the sibling directory `target`; a junction on Windows. */
export function linkCurrent(root: string, kind: CurrentKind, target: string): void {
	const link = currentLink(root, kind);
	if (process.platform === "win32") {
		rmSync(link, { force: true });
		symlinkSync(join(root, kind, target), link, "junction");
		return;
	}
	const staged = `${link}.${process.pid}.tmp`;
	rmSync(staged, { force: true });
	symlinkSync(target, staged);
	renameSync(staged, link);
}
