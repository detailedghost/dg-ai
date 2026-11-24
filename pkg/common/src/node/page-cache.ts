import { closeSync, fsyncSync, openSync } from "node:fs";

const POSIX_FADV_DONTNEED = 4;

type Fadvise = (fd: number, offset: number, length: number, advice: number) => number;

let fadvise: Fadvise | undefined;

function loadFadvise(): Fadvise {
	if (fadvise) return fadvise;
	const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
	const libc = dlopen("libc.so.6", {
		posix_fadvise: { args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i32], returns: FFIType.i32 },
	});
	fadvise = (fd, offset, length, advice) => libc.symbols.posix_fadvise(fd, offset, length, advice);
	return fadvise;
}

/** Drops a file from the Linux page cache, so the next process maps it as read from disk; false when it cannot. */
export function evictFromPageCache(path: string): boolean {
	if (process.platform !== "linux") return false;
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
		return loadFadvise()(fd, 0, 0, POSIX_FADV_DONTNEED) === 0;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
