import { existsSync, rmSync } from "node:fs";
import { writeFileAtomic } from "@dg/common/node";
import { type SystemChannel, systemBrowserPresent } from "./core/browser";
import { browsersDir, downloadedChromium, markerPath } from "./core/downloaded";
import { ensurePrivateDir } from "./core/files";

export type BrowserStatus = {
	system: SystemChannel | "none";
	downloaded: string;
};

export type RegistryInstall = (
	browsersPath: string,
) => Promise<{ version: string; executablePath: string }>;

async function installChromium(
	browsersPath: string,
): Promise<{ version: string; executablePath: string }> {
	process.env["PLAYWRIGHT_BROWSERS_PATH"] = browsersPath;
	const { registry } = await import("playwright-core/lib/coreBundle");
	const executable = registry.registry.findExecutable("chromium");
	if (!executable)
		throw new Error(
			"playwright-core has no chromium download for this platform",
		);
	await registry.registry.install([executable]);
	const executablePath = executable.executablePath();
	if (!executablePath)
		throw new Error("Chromium installed but its executable path is unknown");
	return {
		version: executable.browserVersion ?? executable.revision,
		executablePath,
	};
}

export async function installBrowser(
	install: RegistryInstall = installChromium,
	dir: string = browsersDir(),
): Promise<{ version: string; executablePath: string }> {
	ensurePrivateDir(dir);
	const installed = await install(dir);
	writeFileAtomic(markerPath(dir), `${JSON.stringify(installed)}\n`, 0o600);
	return installed;
}

export function browserStatus(
	dir: string = browsersDir(),
	system = systemBrowserPresent,
): BrowserStatus {
	const channel = (["chrome", "msedge"] as const).find((candidate) =>
		system(candidate),
	);
	return {
		system: channel ?? "none",
		downloaded: downloadedChromium(dir)?.version ?? "none",
	};
}

export function removeBrowser(dir: string = browsersDir()): boolean {
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}
