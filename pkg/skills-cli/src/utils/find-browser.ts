import { existsSync } from "node:fs";
import path from "node:path";

export type FinderSeams = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	which(name: string): string | null;
	exists(file: string): boolean;
};

export const PATH_CANDIDATES = [
	"brave-browser",
	"brave",
	"brave-browser-beta",
	"brave-browser-nightly",
	"chromium",
	"chromium-browser",
	"vivaldi",
	"vivaldi-stable",
	"google-chrome-for-testing",
	"chrome-for-testing",
];

const DARWIN_APPS = [
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	"/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
];

const WINDOWS_APPS = [
	"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
	"\\BraveSoftware\\Brave-Browser-Beta\\Application\\brave.exe",
	"\\Chromium\\Application\\chrome.exe",
	"\\Vivaldi\\Application\\vivaldi.exe",
];

export const DEFAULT_FINDER_SEAMS: FinderSeams = {
	env: process.env,
	platform: process.platform,
	which: (name) => Bun.which(name),
	exists: existsSync,
};

export function windowsPrefixes(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const drive = env["HOMEDRIVE"];
	return [
		env["LOCALAPPDATA"],
		env["PROGRAMFILES"],
		env["PROGRAMFILES(X86)"],
		drive && `${drive}\\Program Files`,
		drive && `${drive}\\Program Files (x86)`,
	].filter((prefix): prefix is string => Boolean(prefix));
}

export function browserOverride(
	env: Record<string, string | undefined> = process.env,
): string | null {
	return env["DG_BROWSER"] || env["DG_VERIFY_BROWSER"] || null;
}

function appPaths(seams: FinderSeams): string[] {
	if (seams.platform === "darwin") return DARWIN_APPS;
	if (seams.platform !== "win32") return [];
	return windowsPrefixes(seams.env).flatMap((prefix) =>
		WINDOWS_APPS.map((app) => path.win32.join(prefix, app)),
	);
}

/** A Chromium-family binary other than the Chrome and Edge channels. */
export function findInstalledChromium(
	seams: FinderSeams = DEFAULT_FINDER_SEAMS,
): string | null {
	const override = browserOverride(seams.env);
	if (override) return override;
	for (const name of PATH_CANDIDATES) {
		const found = seams.which(name);
		if (found) return found;
	}
	return appPaths(seams).find((file) => seams.exists(file)) ?? null;
}
