import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isPathInside, resolveDgPaths } from "@dg/common/node";

const MARKER = "chromium.json";

export type DownloadedChromium = { version: string; executablePath: string };

export const browsersDir = (): string => resolveDgPaths().browsersDir;

export const markerPath = (dir: string = browsersDir()): string =>
	path.join(dir, MARKER);

export function downloadedChromium(
	dir: string = browsersDir(),
): DownloadedChromium | null {
	try {
		const marker = JSON.parse(
			readFileSync(markerPath(dir), "utf8"),
		) as Partial<DownloadedChromium>;
		const { version, executablePath } = marker;
		if (typeof version !== "string" || typeof executablePath !== "string")
			return null;
		return existsSync(executablePath) && isPathInside(executablePath, dir)
			? { version, executablePath }
			: null;
	} catch {
		return null;
	}
}
