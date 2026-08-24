import { constants, lstatSync, realpathSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describeError, isEnoent } from "@dg/common";

export class AssetPathUnsafeError extends Error {}

export class AssetMissingError extends Error {}

const ASSET_READ_FLAGS =
	constants.O_RDONLY |
	(constants.O_NOFOLLOW ?? 0) |
	(constants.O_NONBLOCK ?? 0);

function isContainedBy(root: string, target: string): boolean {
	const rel = relative(root, target);
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${sep}`) &&
		!isAbsolute(rel)
	);
}

export function lstatIfExists(
	path: string,
): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

export function assertRealDirectory(path: string, message: string): void {
	const info = lstatIfExists(path);
	if (!info || info.isSymbolicLink() || !info.isDirectory()) {
		throw new AssetPathUnsafeError(message);
	}
}

export function assertFlatSegment(name: string): void {
	if (
		name.length === 0 ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		isAbsolute(name)
	) {
		throw new AssetPathUnsafeError(`"${name}" is not a flat path segment`);
	}
}

export function resolveAssetFilePath(
	root: string,
	sessionId: string,
	storedName: string,
): string {
	if (!isAbsolute(root)) {
		throw new AssetPathUnsafeError(`assets root ${root} is not absolute`);
	}
	assertFlatSegment(sessionId);
	assertFlatSegment(storedName);

	const rootInfo = lstatIfExists(root);
	if (!rootInfo) {
		throw new AssetMissingError(`assets root ${root} does not exist`);
	}
	if (rootInfo.isSymbolicLink()) {
		throw new AssetPathUnsafeError(`assets root ${root} is a symbolic link`);
	}
	if (!rootInfo.isDirectory()) {
		throw new AssetPathUnsafeError(`assets root ${root} is not a directory`);
	}

	const target = resolve(root, sessionId, storedName);
	if (!isContainedBy(root, target)) {
		throw new AssetPathUnsafeError(
			`asset "${storedName}" resolves outside the assets root`,
		);
	}

	const components = relative(root, target).split(sep);
	let current = root;
	for (const [index, component] of components.entries()) {
		current = join(current, component);
		const info = lstatIfExists(current);
		if (!info) {
			throw new AssetMissingError(`asset "${storedName}" was never staged`);
		}
		if (info.isSymbolicLink()) {
			throw new AssetPathUnsafeError(`${current} is a symbolic link`);
		}
		const isLeaf = index === components.length - 1;
		if (isLeaf ? !info.isFile() : !info.isDirectory()) {
			throw new AssetPathUnsafeError(
				`${current} is not a ${isLeaf ? "regular file" : "directory"}`,
			);
		}
	}

	if (!isContainedBy(realpathSync(root), realpathSync(target))) {
		throw new AssetPathUnsafeError(
			`asset "${storedName}" resolves outside the assets root`,
		);
	}

	return target;
}

export async function openAssetFile(
	root: string,
	sessionId: string,
	storedName: string,
): Promise<FileHandle> {
	const path = resolveAssetFilePath(root, sessionId, storedName);
	try {
		return await open(path, ASSET_READ_FLAGS);
	} catch (err) {
		if (isEnoent(err)) {
			throw new AssetMissingError(`asset "${storedName}" was never staged`);
		}
		throw new AssetPathUnsafeError(
			`asset "${storedName}" could not be opened without following a link: ${describeError(err)}`,
		);
	}
}
